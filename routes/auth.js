// Login + signup routes. Thin on purpose: parse the request, call the
// service, send the response — the actual logic lives in services/auth-service.js.

const express = require('express');
const router = express.Router();
const { syncUserProfile, getUserRole, sendVerification, verifyEmailToken, sendPasswordReset, checkVerified } = require('../services/auth-service');

/**
 * @swagger
 * /user/sync:
 *   post:
 *     summary: Called on every login — upserts the Firebase-authenticated user into Supabase users table (read-only lookup if name is omitted), resolves school_id, and returns the full profile
 *     tags: [User]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               name: { type: string }
 *               email: { type: string }
 *               role: { type: string, description: "Only applied on first signup or if it matches the existing role" }
 *               grade: { type: string }
 *               school: { type: string }
 *               curriculum: { type: string }
 *               location: { type: string }
 *     responses:
 *       200:
 *         description: "Full user profile (id, name, email, role, roles, grade, school, schoolId, curriculum, phone, onboardingComplete, photoUrl, isPro, mustChangePassword, accountStatus); or just email plus onboardingComplete false if no row exists yet"
 *       400: { description: email missing }
 */
router.post('/sync', syncUserProfile);

/**
 * @swagger
 * /user/role:
 *   get:
 *     summary: Get the registered role for an email (used on signup to show a helpful "already registered as X" error)
 *     tags: [User]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ role }" }
 *       400: { description: email missing }
 *       404: { description: User not found }
 */
router.get('/role', getUserRole);

/**
 * @swagger
 * /user/send-verification:
 *   post:
 *     summary: Send a branded email-verification link (short-linked via /v/:code) from aivorah24@gmail.com; no-op if the account is already active
 *     tags: [User]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, name]
 *             properties:
 *               email: { type: string }
 *               name: { type: string }
 *               frontendOrigin: { type: string, description: "Defaults to https://aivorah.ai" }
 *     responses:
 *       200:
 *         description: "ok true, or ok true with alreadyVerified true if already active"
 *       400: { description: email or name missing }
 */
router.post('/send-verification', sendVerification);

/**
 * @swagger
 * /user/verify/{token}:
 *   get:
 *     summary: Verification link landing endpoint — validates the token, marks the account active, then redirects to the frontend with ?verified=1 or ?error=1
 *     tags: [User]
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: email
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: redirect
 *         schema: { type: string, description: "Frontend URL to redirect to; defaults to https://aivorah.ai/verify-success" }
 *     responses:
 *       302: { description: Redirects to the frontend with verified=1 (success or already-verified) or error=1 (invalid/expired token) }
 */
router.get('/verify/:token', verifyEmailToken);

/**
 * @swagger
 * /user/send-password-reset:
 *   post:
 *     summary: Generate a Firebase password-reset link (rewritten to the app's themed page) and send it from aivorah24@gmail.com — for @aivorah.student synthetic accounts the email is delivered to the linked parent instead
 *     tags: [User]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string }
 *               frontendOrigin: { type: string, description: "Defaults to https://aivorah.ai" }
 *     responses:
 *       200:
 *         description: "ok true (also returned, without leaking existence, when the account isn't found or has no deliverable parent email)"
 *       400: { description: email missing }
 */
router.post('/send-password-reset', sendPasswordReset);

/**
 * @swagger
 * /user/check-verified:
 *   get:
 *     summary: Get the current accountStatus for an email — polled by VerifyEmailScreen to detect when verification completes
 *     tags: [User]
 *     parameters:
 *       - in: query
 *         name: email
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: "{ verified: boolean, accountStatus }" }
 *       400: { description: email missing }
 */
router.get('/check-verified', checkVerified);

module.exports = router;
