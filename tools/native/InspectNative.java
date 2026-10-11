// Exporta funções do SCUS_976.21 (asm + pseudocódigo C + relatório) a partir de um arquivo de alvos.
// SPEC §8.3. Uso (headless):
//   analyzeHeadless artifacts/native/project tmho -process scus_976.21 -noanalysis -scriptPath tools/native
//     -postScript InspectNative.java tools/native/<alvos>.txt artifacts/native/<saida>
//
// DSL do arquivo de alvos (uma por linha, '#' comenta):
//   <hexaddr> <rótulo>        âncora: xrefs ao endereço -> funções que o referenciam (+1 nível se a xref está em dados)
//   at:<hexaddr> <rótulo>     a função que contém o endereço
//   range:<ini>:<fim>         todas as funções com entrada no intervalo
//   str:<regex> <rótulo>      strings definidas que casam com a regex -> funções que as referenciam (use \s, não espaço)
//   refsrange:<ini>:<fim> <r> funções que referenciam QUALQUER endereço no intervalo (tabelas acessadas por campo)
// Exporta as raízes + chamadas diretas (profundidade 1), limite 120 funções, decompile 20 s cada.
//@category TMHO

import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.data.StringDataInstance;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.Reference;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

public class InspectNative extends GhidraScript {
    private static final int LIMIT = 120;

    private final Map<Address, Set<String>> roots = new LinkedHashMap<>();
    private final List<String> unresolved = new ArrayList<>();

    @Override
    protected void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length < 2) throw new IllegalArgumentException("uso: InspectNative <alvos.txt> <saida>");
        Path out = Paths.get(args[1]);
        Files.createDirectories(out);

        for (String raw : Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8)) {
            String line = raw.replaceAll("#.*", "").trim();
            if (line.isEmpty()) continue;
            String[] p = line.split("\\s+", 2);
            String label = p.length > 1 ? p[1] : p[0];
            if (p[0].startsWith("at:")) addFunc(toAddr(p[0].substring(3)), label);
            else if (p[0].startsWith("range:")) {
                String[] r = p[0].split(":");
                Address a = toAddr(r[1]), b = toAddr(r[2]);
                for (Function f : currentProgram.getFunctionManager().getFunctions(a, true)) {
                    if (f.getEntryPoint().compareTo(b) > 0) break;
                    root(f, label);
                }
            } else if (p[0].startsWith("str:")) anchorStrings(Pattern.compile(p[0].substring(4)), label);
            else if (p[0].startsWith("refsrange:")) {
                String[] r = p[0].split(":");
                Address a = toAddr(r[1]), b = toAddr(r[2]);
                int hits = 0;
                var it = currentProgram.getReferenceManager().getReferenceDestinationIterator(new ghidra.program.model.address.AddressSet(a, b), true);
                while (it.hasNext()) {
                    Address dst = it.next();
                    for (Reference ref : getReferencesTo(dst)) {
                        Function f = getFunctionContaining(ref.getFromAddress());
                        if (f != null) {
                            root(f, label + " +" + Long.toHexString(dst.subtract(a)));
                            hits++;
                        }
                    }
                }
                if (hits == 0) unresolved.add(label + " (nenhuma referência em " + a + ".." + b + ")");
            }
            else anchor(toAddr(p[0]), label, 1);
        }

        // Raízes + chamadas diretas.
        LinkedHashMap<Function, Set<String>> export = new LinkedHashMap<>();
        for (Map.Entry<Address, Set<String>> e : roots.entrySet()) {
            Function f = getFunctionAt(e.getKey());
            if (f == null) continue;
            export.computeIfAbsent(f, k -> new TreeSet<>()).addAll(e.getValue());
        }
        for (Function f : new ArrayList<>(export.keySet())) {
            for (Function c : f.getCalledFunctions(monitor)) {
                if (export.size() >= LIMIT) break;
                export.computeIfAbsent(c, k -> new TreeSet<>()).add("chamada por " + f.getName());
            }
        }

        DecompInterface dec = new DecompInterface();
        dec.openProgram(currentProgram);
        StringBuilder report = new StringBuilder("{\n \"program\": \"" + currentProgram.getName() + "\",\n \"functions\": [\n");
        int n = 0;
        for (Map.Entry<Function, Set<String>> e : export.entrySet()) {
            if (n >= LIMIT) break;
            Function f = e.getKey();
            String base = f.getEntryPoint().toString() + "_" + f.getName().replaceAll("[^A-Za-z0-9_]", "_");
            DecompileResults r = dec.decompileFunction(f, 20, monitor);
            String c = r.decompileCompleted() ? r.getDecompiledFunction().getC() : "// decompile falhou: " + r.getErrorMessage();
            Files.writeString(out.resolve(base + ".c"), "// " + String.join("; ", e.getValue()) + "\n" + c);
            Files.writeString(out.resolve(base + ".asm"), asm(f));
            report.append(n == 0 ? "" : ",\n").append("  {\"entry\": \"").append(f.getEntryPoint())
                  .append("\", \"name\": \"").append(f.getName()).append("\", \"why\": ").append(jsonList(e.getValue()))
                  .append(", \"calls\": ").append(jsonList(names(f.getCalledFunctions(monitor))))
                  .append(", \"callers\": ").append(jsonList(names(f.getCallingFunctions(monitor)))).append("}");
            n++;
        }
        report.append("\n ],\n \"unresolved\": ").append(jsonList(unresolved)).append("\n}\n");
        Files.writeString(out.resolve("report.json"), report.toString());
        println("InspectNative: " + n + " funções exportadas em " + out + "; não resolvidos: " + unresolved.size());
    }

    private void root(Function f, String why) {
        roots.computeIfAbsent(f.getEntryPoint(), k -> new TreeSet<>()).add(why);
    }

    private void addFunc(Address a, String why) {
        Function f = getFunctionContaining(a);
        if (f == null) unresolved.add(why + " @" + a);
        else root(f, why);
    }

    /** xrefs ao endereço; se a xref estiver em dados (tabela/vtable), segue mais um nível. */
    private void anchor(Address a, String why, int depth) {
        boolean any = false;
        for (Reference r : getReferencesTo(a)) {
            Function f = getFunctionContaining(r.getFromAddress());
            if (f != null) {
                root(f, why);
                any = true;
            } else if (depth > 0) {
                anchor(r.getFromAddress(), why + " (via dado " + r.getFromAddress() + ")", depth - 1);
                any = true;
            }
        }
        if (!any) unresolved.add(why + " @" + a + " (sem xrefs)");
    }

    private void anchorStrings(Pattern re, String why) {
        int hits = 0;
        for (Data d : currentProgram.getListing().getDefinedData(true)) {
            if (!d.hasStringValue()) continue;
            String s = StringDataInstance.getStringDataInstance(d).getStringValue();
            if (s == null || !re.matcher(s).find()) continue;
            hits++;
            anchor(d.getAddress(), why + " \"" + s.replace("\"", "'") + "\"", 1);
        }
        if (hits == 0) unresolved.add(why + " (nenhuma string casou " + re + ")");
    }

    private String asm(Function f) {
        StringBuilder sb = new StringBuilder();
        for (Instruction i : currentProgram.getListing().getInstructions(f.getBody(), true))
            sb.append(i.getAddress()).append("  ").append(i).append('\n');
        return sb.toString();
    }

    private static List<String> names(Set<Function> fs) {
        List<String> l = new ArrayList<>();
        for (Function f : fs) l.add(f.getName() + "@" + f.getEntryPoint());
        Collections.sort(l);
        return l;
    }

    private static String jsonList(Collection<String> items) {
        StringBuilder sb = new StringBuilder("[");
        int i = 0;
        for (String s : items) {
            StringBuilder e = new StringBuilder();
            for (char ch : s.toCharArray()) {
                if (ch == '\\' || ch == '"') e.append('\\').append(ch);
                else if (ch < 0x20) e.append(String.format("\\u%04x", (int) ch));
                else e.append(ch);
            }
            sb.append(i++ == 0 ? "" : ", ").append('"').append(e).append('"');
        }
        return sb.append(']').toString();
    }
}
