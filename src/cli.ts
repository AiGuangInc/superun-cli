#!/usr/bin/env node
import { createProgram } from "./program.js";

createProgram()
  .then((program) => program.parseAsync(process.argv))
  .catch((e) => {
    console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
