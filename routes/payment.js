const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const User = require('../models/User');

// Créer les produits et les prix Stripe (à exécuter une seule fois)
async function createStripePrices() {
  const products = [
    { name: 'Blog Basic', description: '100 jetons par mois', price: 2990 },
    { name: 'Blog Pro', description: '250 jetons par mois', price: 5990 },
    { name: 'Blog Enterprise', description: '500 jetons par mois', price: 9990 },
    { name: 'Jetons supplémentaires', description: '100 jetons', price: 2000 }
  ];

  for (const product of products) {
    const stripeProduct = await stripe.products.create({
      name: product.name,
      description: product.description,
    });

    if (product.name === 'Jetons supplémentaires') {
      await stripe.prices.create({
        product: stripeProduct.id,
        unit_amount: product.price,
        currency: 'eur',
      });
    } else {
      await stripe.prices.create({
        product: stripeProduct.id,
        unit_amount: product.price,
        currency: 'eur',
        recurring: { interval: 'month' },
      });
    }
  }
}

// Créez une route pour initialiser les produits et les prix (à exécuter une seule fois)
router.get('/init-stripe-products', async (req, res) => {
  try {
    await createStripePrices();
    res.json({ message: 'Produits et prix Stripe initialisés avec succès' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour créer une session de paiement pour un abonnement
router.post('/create-subscription', async (req, res) => {
  const { priceId, userId } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      client_reference_id: userId,
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route pour créer une session de paiement pour l'achat de jetons supplémentaires
router.post('/buy-tokens', async (req, res) => {
  const { priceId, userId, quantity } = req.body;

  if (quantity < 1) {
    return res.status(400).json({ error: 'La quantité minimale est de 1 (100 jetons)' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: quantity }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/cancel`,
      client_reference_id: userId,
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Gérer les différents types d'événements
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      if (session.mode === 'subscription') {
        await handleSubscriptionPurchase(session);
      } else if (session.mode === 'payment') {
        await handleTokenPurchase(session);
      }
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCancelled(event.data.object);
      break;
    // Ajoutez d'autres cas au besoin
  }

  res.json({received: true});
});

async function handleSubscriptionPurchase(session) {
  const userId = session.client_reference_id;
  const user = await User.findById(userId);
  if (user) {
    user.stripeSubscriptionId = session.subscription;
    user.stripePlanId = session.planId; // Assurez-vous de passer le planId lors de la création de la session
    await user.save();
    // La mise à jour des jetons se fera au renouvellement de l'abonnement
  }
}

async function handleTokenPurchase(session) {
  const userId = session.client_reference_id;
  const user = await User.findById(userId);
  if (user) {
    const tokensToAdd = session.amount_total / 20; // 20 centimes par jeton
    await user.addTokens(tokensToAdd);
  }
}

async function handleSubscriptionCancelled(subscription) {
  const user = await User.findOne({ stripeSubscriptionId: subscription.id });
  if (user) {
    user.stripeSubscriptionId = null;
    user.stripePlanId = null;
    await user.save();
  }
}

// Webhook pour gérer le renouvellement de l'abonnement
router.post('/subscription-renewed', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'invoice.paid') {
    const subscription = event.data.object;
    await handleSubscriptionRenewal(subscription);
  }

  res.json({received: true});
});

async function handleSubscriptionRenewal(subscription) {
  const user = await User.findOne({ stripeSubscriptionId: subscription.subscription });
  if (user) {
    let tokensToAdd;
    switch (user.stripePlanId) {
      case 'price_id_for_2990_plan':
        tokensToAdd = 100;
        break;
      case 'price_id_for_5990_plan':
        tokensToAdd = 250;
        break;
      case 'price_id_for_9990_plan':
        tokensToAdd = 500;
        break;
      default:
        tokensToAdd = 0;
    }
    user.tokens = tokensToAdd; // Réinitialiser les jetons au lieu d'ajouter
    await user.save();
  }
}

module.exports = router;