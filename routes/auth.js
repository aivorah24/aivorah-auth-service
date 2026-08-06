// Login-related routes. Thin on purpose: parse the request, call the
// service, send the response — the actual logic lives in services/auth-service.js.

const express = require('express');
const router = express.Router();
const { syncUserProfile } = require('../services/auth-service');

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

module.exports = router;
