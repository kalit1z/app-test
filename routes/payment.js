const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');

router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gérer l'événement de paiement réussi
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    
    // Récupérer l'utilisateur et ajouter les crédits
    const userId = session.client_reference_id;
    const user = await User.findById(userId);
    if (user) {
      const creditsToAdd = Math.floor(session.amount_total / 20); // 20 centimes par crédit
      await user.addCredits(creditsToAdd);
      console.log(`${creditsToAdd} crédits ajoutés pour l'utilisateur ${userId}`);
    }
  }

  res.json({received: true});
});

module.exports = router;