import process from "node:process";

if (!process.env.AGENTBEAN_RAW_REPORT_PATH) {
  throw new Error("missing report path");
}

process.report.excludeEnv = false;
process.report.excludeNetwork = false;
process.report.writeReport(process.env.AGENTBEAN_RAW_REPORT_PATH);
