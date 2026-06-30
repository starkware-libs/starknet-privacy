import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

interface ContractClass {
  abi: unknown[];
}

interface GenerateContractAbiOptions {
  scriptUrl: string;
  inputPathFromScriptsDir: string;
  outputPathFromScriptsDir: string;
  contractName: string;
  exportName: string;
  regenerateCommand: string;
  errorLabel: string;
  extraHeaderLines?: string[];
}

export function generateContractAbi({
  scriptUrl,
  inputPathFromScriptsDir,
  outputPathFromScriptsDir,
  contractName,
  exportName,
  regenerateCommand,
  errorLabel,
  extraHeaderLines,
}: GenerateContractAbiOptions): void {
  const scriptsDir = dirname(fileURLToPath(scriptUrl));
  const inputPath = join(scriptsDir, inputPathFromScriptsDir);
  const outputPath = join(scriptsDir, outputPathFromScriptsDir);

  try {
    const contractClass: ContractClass = JSON.parse(readFileSync(inputPath, "utf-8"));
    const headerLines = [
      `${contractName} Contract ABI`,
      "",
      "This file is auto-generated from Cairo build artifacts.",
      `Do not edit manually - run '${regenerateCommand}' to regenerate.`,
    ];
    if (extraHeaderLines !== undefined) {
      headerLines.push("", ...extraHeaderLines);
    }

    const output = `/**
${headerLines.map((line) => (line === "" ? " *" : ` * ${line}`)).join("\n")}
 */

export const ${exportName} = ${JSON.stringify(contractClass.abi, null, 2)} as const;
`;

    writeFileSync(outputPath, output);
    console.log("Successfully generated", outputPath);

    execFileSync("prettier", ["--write", outputPath], { stdio: "inherit" });
  } catch (error) {
    console.error(`Error generating ${errorLabel}:`, (error as Error).message);
    process.exit(1);
  }
}
