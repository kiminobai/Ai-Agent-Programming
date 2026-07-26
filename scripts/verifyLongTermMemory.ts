import { getProviderConfig } from "../src/config";
import { LangChainProvider } from "../src/providers/langChainProvider";

async function main() {
  // 学习点：这个脚本不是 Web 服务，而是一个手动验证长期记忆的实验。
  // 为什么这样：不用点前端，也能快速确认 userId 相同/不同对长期记忆隔离的影响。
  const provider = new LangChainProvider(
    "deepseek",
    getProviderConfig("deepseek")
  );

  if (!provider.isAvailable()) {
    throw new Error("DeepSeek provider is not available. Check DEEPSEEK_API_KEY.");
  }

  const modelId = "deepseek-v4-flash";
  // 学习点：系统提示明确要求模型在需要时使用 memory tools。
  // 为什么这样：长期记忆不是 LLM 自己保存的，必须通过工具写入/读取数据库。
  const systemPrompt =
    "You are a careful AI assistant. Use memory tools when the user asks you to remember or recall preferences.";

  const sharedUserId = "memory-user-demo";
  const isolatedUserId = "memory-user-isolated";
  const firstThreadId = "memory-thread-a";
  const secondThreadId = "memory-thread-b";
  const thirdThreadId = "memory-thread-c";

  console.log("Scenario 1: save long-term memory for the first user.");
  // 步骤 1：同一个 userId 第一次告诉 Agent 偏好，让工具写入长期记忆。
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
  // 步骤 2：换 threadId 但保持 userId，验证长期记忆可以跨对话读取。
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
  // 步骤 3：换 userId，验证不同用户之间的长期记忆不会串。
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
