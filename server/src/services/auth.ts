import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

export interface AuthClaims {
  userId: string;
  tenantId: string;
  role: string;
  email: string;
}

export function hashPassword(pw: string): string {
  return bcrypt.hashSync(pw, 10);
}

export function verifyPassword(pw: string, hash: string): boolean {
  return bcrypt.compareSync(pw, hash);
}

export function signToken(claims: AuthClaims): string {
  return jwt.sign(claims, config.authSecret, { expiresIn: '12h' });
}

export function verifyToken(token: string): AuthClaims | null {
  try {
    return jwt.verify(token, config.authSecret) as AuthClaims;
  } catch {
    return null;
  }
}
