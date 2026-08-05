import { getDatabaseForThread, sqliteDb } from "../db/sqlite";

export const USER_PREFERENCES_NAMESPACE = "user_preferences";
export const THEME_PREFERENCE_KEY = "theme";

// 学习点：长期记忆保存的是“跨对话仍然有用的信息”。
// 这里先用最小例子：用户偏好深色主题。
export interface UserPreferenceMemory {
  preferenceType: "theme";
  value: string;
  updatedAt: string;
  source: "tool";
}

export function saveUserPreference(
  userId: string,
  memory: UserPreferenceMemory,
  threadId?: string
): void {
  // 学习点：长期记忆按 userId 隔离。
  // 换 thread_id 还能读到；换 userId 就读不到。
  (threadId ? getDatabaseForThread(threadId) : sqliteDb)
    .prepare(
      `
        INSERT INTO user_preferences (
          user_id,
          preference_type,
          value,
          updated_at,
          source
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, preference_type) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at,
          source = excluded.source
      `
    )
    .run(
      userId,
      memory.preferenceType,
      memory.value,
      memory.updatedAt,
      memory.source
    );
}

export function getUserPreference(
  userId: string,
  preferenceType: UserPreferenceMemory["preferenceType"],
  threadId?: string
): UserPreferenceMemory | null {
  // 学习点：读取长期记忆时，只按当前 userId 和偏好类型查。
  const row = (threadId ? getDatabaseForThread(threadId) : sqliteDb)
    .prepare(
      `
        SELECT preference_type, value, updated_at, source
        FROM user_preferences
        WHERE user_id = ? AND preference_type = ?
      `
    )
    .get(userId, preferenceType) as
    | {
        preference_type: string;
        value: string;
        updated_at: string;
        source: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    preferenceType: row.preference_type as "theme",
    value: row.value,
    updatedAt: row.updated_at,
    source: row.source as "tool"
  };
}
