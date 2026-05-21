# @agentgateeu/mcp-server

MCP server for [AgentGate](https://agentgate.eu) — lets Claude Desktop submit and track AI payment requests through your authorization rules.

## Setup

1. Get a connection key from your [AgentGate dashboard](https://agentgate.eu/settings/agents/new)
2. Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agentgate": {
      "command": "/usr/local/bin/npx",
      "args": ["-y", "@agentgateeu/mcp-server"],
      "env": {
        "AGENTGATE_API_KEY": "your-connection-key-here"
      }
    }
  }
}
```

> Use the absolute path from `which npx` as the command value.

## Tools

| Tool | Description |
|---|---|
| `submit_payment` | Submit a payment request for authorization |
| `get_payment_status` | Get the current status of a payment request |
| `wait_for_decision` | Wait for a human to approve or reject a pending payment |
| `cancel_payment` | Cancel a pending payment request |

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AGENTGATE_API_KEY` | Yes | Your AgentGate connection key |
| `AGENTGATE_BASE_URL` | No | Override API base URL (default: `https://agentgate.eu`) |
