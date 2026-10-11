# Roda InspectNative.java no projeto Ghidra. Uso: powershell -File tools/native/run.ps1 <alvos.txt> <saida>
param([string]$Targets, [string]$Out)
$env:JAVA_HOME = "$env:LOCALAPPDATA\Programs\jdk-21.0.12.1+1"
$G = "$env:LOCALAPPDATA\Programs\ghidra_12.1.3_PUBLIC"
& "$G\support\analyzeHeadless.bat" 'artifacts\native\project' 'tmho' -process 'scus_976.21' -noanalysis -readOnly -scriptPath 'tools\native' -postScript 'InspectNative.java' $Targets $Out *> "$Out.log"
Select-String -Path "$Out.log" -Pattern 'InspectNative:|ERROR|Exception' | Select-Object -First 8 | ForEach-Object { $_.Line }
