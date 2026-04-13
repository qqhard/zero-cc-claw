# Optional Plugins

Copy any plugin folder into `.claude/skills/` to enable it.

```bash
cp -r plugins/<plugin-name> .claude/skills/
```

## Available Plugins

| Plugin | Description |
|--------|-------------|
| (coming soon) | Email summary, calendar sync, knowledge base search, etc. |

## Writing a Plugin

A plugin is a Claude Code skill — a folder with a `SKILL.md` file:

```
my-plugin/
  SKILL.md     # Describes trigger, behavior, allowed tools
  *.mjs        # Optional helper scripts
```

See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) for skill authoring details.
