import { getProviderConfig } from "../src/config";
import { LangChainProvider } from "../src/providers/langChainProvider";

async function main() {
  const provider = new LangChainProvider(
    "deepseek",
    getProviderConfig("deepseek")
  );

  if (!provider.isAvailable()) {
    throw new Error("DeepSeek provider is not available. Check DEEPSEEK_API_KEY.");
  }

  const modelId = "deepseek-v4-flash";
  const systemPrompt =
    "You are a careful AI assistant. Use memory tools when the user asks you to remember or recall preferences.";

  const sharedUserId = "memory-user-demo";
  const isolatedUserId = "memory-user-isolated";
  const firstThreadId = "memory-thread-a";
  const secondThreadId = "memory-thread-b";
  const thirdThreadId = "memory-thread-c";

  console.log("Scenario 1: save long-term memory for the first user.");
  const firstReply = await provider.sendChat(
    modelId,
    "Please remember that I prefer dark theme for future chats. Use the memory tool and confirm what you saved.",
    systemPrompt,
    [],
    undefined,
    firstThreadId,
    sharedUserId
  );
  console.log(firstReply);
  console.log("");

  console.log("Scenario 2: switch thread_id, keep the same userId, then ask for the remembered preference.");
  const secondReply = await provider.sendChat(
    modelId,
    "This is a new thread. What theme preference do you remember for me?",
    systemPrompt,
    [],
    undefined,
    secondThreadId,
    sharedUserId
  );
  console.log(secondReply);
  console.log("");

  console.log("Scenario 3: switch userId and verify memory isolation.");
  const thirdReply = await provider.sendChat(
    modelId,
    "This is another user. What theme preference do you remember for me?",
    systemPrompt,
    [],
    undefined,
    thirdThreadId,
    isolatedUserId
  );
  console.log(thirdReply);
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Failed to verify long-term memory."
  );
  process.exitCode = 1;
});
