import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { asyncHandler, authenticate, HttpError } from '../middleware/index.js';
import { hashPassword, verifyPassword, signToken } from '../services/auth.js';

export const authRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6) });

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !verifyPassword(password, user.passwordHash)) throw new HttpError(401, 'Invalid credentials');
  const token = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId } });
}));

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  tenantName: z.string().optional(),
  role: z.string().optional(),
});

authRouter.post('/register', asyncHandler(async (req, res) => {
  const body = registerSchema.parse(req.body);
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw new HttpError(409, 'Email already registered');
  const tenant = await prisma.tenant.create({ data: { name: body.tenantName ?? `${body.name}'s Org` } });
  const user = await prisma.user.create({
    data: { email: body.email, name: body.name, passwordHash: hashPassword(body.password), role: body.role ?? 'admin', tenantId: tenant.id },
  });
  const token = signToken({ userId: user.id, tenantId: user.tenantId, role: user.role, email: user.email });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId } });
}));

authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.userId } });
  if (!user) throw new HttpError(404, 'User not found');
  const tenant = await prisma.tenant.findUnique({ where: { id: user.tenantId } });
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, tenant: { id: tenant?.id, name: tenant?.name, region: tenant?.region } });
}));
