#!/bin/bash
cd "$(dirname "$0")"
claude --channels plugin:telegram@claude-plugins-official --dangerously-skip-permissions --project-dir .
