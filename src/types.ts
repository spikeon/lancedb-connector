export type Role = "read" | "write" | "admin";

export interface AuthUser {
  username: string;
  roles: Role[];
  verifyPassword: (plain: string) => Promise<boolean>;
}
