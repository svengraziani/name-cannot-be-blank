# Loop Gateway – Make.com (Integromat) Integration

This directory contains ready-to-import Make.com scenario blueprints for Loop Gateway.

## Setup

### 1. Create a Webhook in Loop Gateway

```bash
curl -X POST http://localhost:3000/api/webhooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "name": "make-integration",
    "platform": "make",
    "events": ["*"]
  }'
```

Save the returned `token` — you'll need it for the Make.com scenarios.

### 2. Import a Blueprint

1. Open Make.com → **Scenarios** → **Create a new scenario**
2. Click **...** → **Import Blueprint**
3. Paste the JSON from one of the blueprint files below
4. Update the Loop Gateway URL and webhook token in the HTTP module settings

## Available Blueprints

### `run-agent.json`
Sends a message to a Loop Gateway agent and receives the AI response.
Use this as a building block in any Make.com scenario.

### `agent-to-google-sheets.json`
Triggers an AI agent with a prompt, then writes the response to a Google Sheets row.
Useful for automated research, content generation, or data enrichment.

### `webhook-trigger.json`
Receives events from Loop Gateway (agent completions, task updates, approvals)
via outbound webhook and processes them in Make.com.

## Custom HTTP Module Configuration

If you prefer to build your own scenarios, configure the HTTP module like this:

**Trigger an Agent Run:**
- URL: `https://your-gateway.com/webhook/invoke/YOUR_TOKEN`
- Method: POST
- Body type: JSON
- Body:
  ```json
  {
    "message": "Your prompt here",
    "sync": true
  }
  ```

**Create a Loop Task:**
- URL: `https://your-gateway.com/webhook/task/YOUR_TOKEN`
- Method: POST
- Body type: JSON
- Body:
  ```json
  {
    "name": "Task name",
    "prompt": "Task prompt",
    "maxIterations": 10
  }
  ```
