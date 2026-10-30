#!/usr/bin/env node
import { createHost, encodeMessage, MessageReader, resolveFfmpeg } from "./ffmpeg-host-lib.mjs";
import { resolveOutputDir, resolveYtdlp } from "./ytdlp-lib.mjs";

const log = (text) => process.stderr.write(`pdm-ffmpeg-host: ${text}\n`);
const host = createHost({
  ffmpeg: resolveFfmpeg(process.env),
  ytdlp: resolveYtdlp(process.env),
  node: process.execPath,
  outputRoot: resolveOutputDir(process.env),
  send: (msg) => process.stdout.write(encodeMessage(msg)),
});
const reader = new MessageReader();

process.stdout.on("error", () => process.exit(0));

process.stdin.on("data", (chunk) => {
  let messages;
  try {
    messages = reader.push(chunk);
  } catch (err) {
    log(err.message);
    process.exit(1);
  }
  for (const msg of messages) host.handle(msg).catch((err) => log(err.message));
});

process.stdin.on("end", async () => {
  setTimeout(() => process.exit(0), 3000).unref();
  await host.shutdown();
  process.exit(0);
});