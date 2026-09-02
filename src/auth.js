import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createUser, findUserByEmail, findUserById, isPaid } from './store.js';

const SECRET = process.env.JWT_SECRET;
const TTL = '30d';

if (!SECRET || SECRET === 'replace-me-with-a-long-random-string') {
  console.error('\n[auth] JWT_SECRET is missing or still the placeholder.');
  console.error('[auth] Set a real one in .env or every session is forgeable.\n');
  process.exit(1);
}

const EMAIL_RX = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export const sign = (user) => jwt.sign({ uid: user.id }, SECRET, { expiresIn: TTL });

export function userFromToken(token) {
  if (!token) return null;
  try {
    return findUserById(jwt.verify(token, SECRET).uid) || null;
  } catch (e) {
    return null;
  }
}

/* What the client is allowed to know about itself. Never leak the hash. */
export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  role: u.role,
  paid: isPaid(u),
  paidUntil: u.paidUntil || 0
});

export async function register(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!EMAIL_RX.test(email)) throw new Error('That email does not look right');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  if (findUserByEmail(email)) throw new Error('That email is already registered');
  const hash = await bcrypt.hash(password, 10);
  return createUser({ email, hash });
}

export async function login(email, password) {
  const user = findUserByEmail(email);
  // Burn the same work when the account does not exist, so response time does
  // not reveal which emails are registered. (Comparing against a fabricated
  // hash would throw instead of returning false, so hash a throwaway instead.)
  if (!user) {
    await bcrypt.hash(String(password || ''), 10);
    throw new Error('Wrong email or password');
  }
  const ok = await bcrypt.compare(String(password || ''), user.hash);
  if (!ok) throw new Error('Wrong email or password');
  return user;
}

/* Express middleware. Reads the token from the Authorization header. */
export function attachUser(req, _res, next) {
  const h = req.headers.authorization || '';
  req.user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : null);
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in first' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admins only' });
  }
  next();
}
