/**
 * Isolated Agent Runner
 *
 * Runs inside a Docker container. Receives all input (API key, messages,
 * system prompt) via stdin as JSON. Outputs response via stdout as JSON.
 * Secrets never touch disk or environment variables.
 *
 * Protocol:
 *   stdin  <- JSON: { apiKey, model, maxTokens, systemPrompt, messages }
 *   stdout -> JSON: { content, inputTokens, outputTokens }
 *   stderr -> logs (forwarded to host)
 *
 * Sentinel markers delimit the JSON output for reliable parsing.
 */

const OUTPUT_START = '===AGENT_OUTPUT_START===';
const OUTPUT_END = '===AGENT_OUTPUT_END===';

async function main() {
  // Read all of stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');

  let input;
  try {
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[agent-runner] Failed to parse stdin: ${err.message}\n`);
    process.exit(1);
  }

  const { apiKey, model, maxTokens, systemPrompt, messages } = input;

  if (!apiKey) {
    process.stderr.write('[agent-runner] Missing apiKey in input\n');
    process.exit(1);
  }

  process.stderr.write(`[agent-runner] Processing ${messages.length} messages with ${model}\n`);

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: maxTokens || 8192,
      system: systemPrompt || 'You are a helpful AI assistant.',
      messages,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const content = textBlocks.map(b => b.text).join('\n');

    const result = {
      content,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };

    // Write result between sentinel markers for reliable parsing
    process.stdout.write(OUTPUT_START + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
    process.stdout.write(OUTPUT_END + '\n');

    process.stderr.write(`[agent-runner] Done: ${response.usage.input_tokens}+${response.usage.output_tokens} tokens\n`);
  } catch (err) {
    process.stderr.write(`[agent-runner] API error: ${err.message}\n`);

    // Still output structured error
    process.stdout.write(OUTPUT_START + '\n');
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n');
    process.stdout.write(OUTPUT_END + '\n');
    process.exit(1);
  }
}

main();
