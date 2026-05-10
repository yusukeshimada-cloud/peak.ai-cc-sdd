const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

process.stdout.write(JSON.stringify({ permission: "deny" }));
