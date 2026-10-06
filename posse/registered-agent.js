#!/usr/bin/env node
import { runRegisteredAgentCli } from "./lib/domains/agents/functions/registered-agent-cli.js";

process.exitCode = await runRegisteredAgentCli();
