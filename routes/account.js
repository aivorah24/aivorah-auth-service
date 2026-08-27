// Account-identity mutation routes — ported from the monolith
// (ai-mentor/server/routes/user.js) 2026-08-27. See services/accountManagement.js.
const express = require('express');
const router = express.Router();
const {
  sendEmailOtp, verifyEmailOtp, changeEmail, changeEmailGoogle, deleteAccount,
} = require('../services/accountManagement');

router.post('/email-otp/send', sendEmailOtp);
router.post('/email-otp/verify', verifyEmailOtp);
router.post('/change-email', changeEmail);
router.post('/change-email-google', changeEmailGoogle);
router.delete('/delete-account', deleteAccount);

module.exports = router;
