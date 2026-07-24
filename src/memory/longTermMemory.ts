import { sqliteDb } from "../db/sqlite";

export const USER_PREFERENCES_NAMESPACE = "user_preferences";
export const THEME_PREFERENCE_KEY = "theme";

export interface UserPreferenceMemory {
  preferenceType: "theme";
  value: string;
  updatedAt: string;
  source: "tool";
}

export function saveUserPreference(
  userId: string,
  memory: UserPreferenceMemory
): void {
  sqliteDb
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
  preferenceType: UserPreferenceMemory["preferenceType"]
): UserPreferenceMemory | null {
  const row = sqliteDb
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
