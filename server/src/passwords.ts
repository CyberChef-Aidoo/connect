import bcrypt from 'bcryptjs';

export const PASSWORD_COST = 12;
const MIN_LENGTH = 10;
const MAX_BYTES = 72;

export async function hashPassword(password: string, cost = PASSWORD_COST): Promise<string> {
  return bcrypt.hash(password, cost);
}

export async function verifyPassword(
  password: string,
  storedHash: string | undefined,
  dummyHash: string,
): Promise<boolean> {
  try {
    const matches = await bcrypt.compare(password, storedHash ?? dummyHash);
    return storedHash !== undefined && matches;
  } catch {
    return false;
  }
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_LENGTH) {
    return `Passwords must be at least ${MIN_LENGTH} characters.`;
  }
  if (Buffer.byteLength(password) > MAX_BYTES) {
    return `Passwords must be ${MAX_BYTES} bytes or fewer.`;
  }
  return null;
}
