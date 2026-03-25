import "dotenv/config";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  runSummaryPipeline,
  DEFAULT_TARGET_MINUTES,
  DEFAULT_TRANSCRIBE_MODEL,
  DEFAULT_SUMMARY_MODEL,
} from "./pipeline.mjs";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.input) {
    printHelp();
    process.exit(options.help ? 0 : 1);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required.");
  }

  const inputPath = path.resolve(options.input);
  const runName = path.parse(inputPath).name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const outputDir = path.resolve(
    options.outputDir || path.join("output", runName),
  );
  await mkdir(outputDir, { recursive: true });

  await runSummaryPipeline({
    apiKey,
    inputPath,
    outputDir,
    targetMinutes: Number(options.targetMinutes || DEFAULT_TARGET_MINUTES),
    transcribeModel: options.transcribeModel || DEFAULT_TRANSCRIBE_MODEL,
    summaryModel: options.summaryModel || DEFAULT_SUMMARY_MODEL,
    stitch: true,
  });
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (!arg.startsWith("--") && !options.input) {
      options.input = arg;
      continue;
    }

    switch (arg) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--output-dir":
        options.outputDir = next;
        index += 1;
        break;
      case "--target-minutes":
        options.targetMinutes = next;
        index += 1;
        break;
      case "--summary-model":
        options.summaryModel = next;
        index += 1;
        break;
      case "--transcribe-model":
        options.transcribeModel = next;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Usage:
  npm start -- /absolute/or/relative/path/to/video.mp4 [options]

Options:
  --output-dir <dir>         Directory for transcript, summary, and final video
  --target-minutes <number>  Desired output length in minutes (default: ${DEFAULT_TARGET_MINUTES})
  --summary-model <name>     OpenAI model for summary and clip selection (default: ${DEFAULT_SUMMARY_MODEL})
  --transcribe-model <name>  OpenAI transcription model (default: ${DEFAULT_TRANSCRIBE_MODEL})
  --help                     Show this help
`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
