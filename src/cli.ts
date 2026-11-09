#!/usr/bin/env node
import { createProgram } from "./program.js";
import { authErrorData } from "./auth/errors.js";

createProgram()
  .then((program) => program.parseAsync(process.argv))
  .catch((e) => {
    const auth = authErrorData(e);
    if (auth) console.error(JSON.stringify(auth));
    else console.error("Error:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
