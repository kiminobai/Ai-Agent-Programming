import crypto from "crypto";

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
};

export type AuthTokenPayload = {
  sub: string;
  username: string;
  displayName: string;
  iat: number;
  exp: number;
};

const TOKEN_HEADER = {
  alg: "HS256",
  typ: "JWT"
};

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signTokenPart(unsignedToken: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(unsignedToken).digest("base64url");
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")): string {
  // 这里用 scrypt 保存密码，而不是明文保存 admin123。
  // 这样即使 SQLite 文件被看到，也不能直接读出用户密码。
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [algorithm, salt, expectedHash] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expectedHash) {
    return false;
  }

  const actualHash = crypto.scryptSync(password, salt, 64).toString("hex");
  const actualBuffer = Buffer.from(actualHash, "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createAuthToken(
  user: AuthUser,
  secret: string,
  ttlSeconds: number
): string {
  // Token 只保存用户身份，不保存密码。
  // 前端刷新后带着 token 调 /api/auth/me，就能恢复同一个 userId 和长期记忆。
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload: AuthTokenPayload = {
    sub: user.id,
    username: user.username,
    displayName: user.displayName,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(TOKEN_HEADER));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = signTokenPart(unsignedToken, secret);
  return `${unsignedToken}.${signature}`;
}

export function verifyAuthToken(token: string, secret: string): AuthTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = signTokenPart(unsignedToken, secret);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8")
    ) as AuthTokenPayload;

    if (!payload.sub || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
