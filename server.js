require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const cheerio = require('cheerio');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Import des modèles
const User = require('./models/User');
const Article = require('./models/Article');

// Configuration de Mongoose
mongoose.set('strictQuery', false);

const app = express();

// Middleware pour les webhooks Stripe
app.use('/stripe-webhook', express.raw({type: 'application/json'}));

// Middleware général
app.use(cors());
app.use(express.json());

// Connexion à la base de données
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

connectDB();

// Middleware d'authentification
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Fonction de scraping avec Axios et Cheerio
const scrapeSEOElements = async (url) => {
  try {
    const response = await axios.get(url);
    const $ = cheerio.load(response.data);

    const h1 = $('h1').first().text().trim();
    const h2s = $('h2').map((_, el) => $(el).text().trim()).get();
    const h3s = $('h3').map((_, el) => $(el).text().trim()).get();
    const text = $('body').text().trim();
    const title = $('title').text().trim();

    return { h1, h2s, h3s, text, title };
  } catch (error) {
    console.error('Error scraping website:', error);
    throw new Error('Failed to scrape website');
  }
};

// Routes
app.post('/register', 
  body('email').isEmail(),
  body('password').isLength({ min: 6 }),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, password } = req.body;
      const user = new User({ email, password, tokens: 5 }); // 5 tokens gratuits à l'inscription
      await user.save();
      res.status(201).json({ message: 'User registered successfully' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
});

app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (user && await user.comparePassword(password)) {
      const token = user.generateAuthToken();
      res.json({ token, tokens: user.tokens });
    } else {
      res.status(400).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/user', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/generate', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (user.tokens <= 0) {
      return res.status(403).json({ error: 'Insufficient tokens' });
    }

    let h1, h2s, h3s, title, url;

    if (req.body.url) {
      url = req.body.url;
      // Scraper les éléments SEO
      const scrapedData = await scrapeSEOElements(url);
      ({ h1, h2s, h3s, title } = scrapedData);
    } else if (req.body.manualInput) {
      ({ h1, h2s } = req.body.manualInput);
      h3s = [];
      title = h1;
      url = 'Manual Input';
    } else {
      return res.status(400).json({ error: 'URL or manual input is required' });
    }

    const prompt = `En tant qu'expert en SEO et rédaction web, génère une variante de contenu basée sur ces éléments SEO :

    H1 : ${h1}
    H2s : ${h2s.join(', ')}
    H3s : ${h3s.join(', ')}
    
    Crée un article de blog optimisé pour le SEO qui :
    1. Utilise ces éléments SEO de manière naturelle et pertinente.
    2. A un contenu unique, original et approfondi.
    3. Est structuré avec une introduction captivante, des sections pour chaque H2 (utilisées comme sous-titres), des sous-sections pour les H3, et une conclusion percutante.
    4. Fait minimum 1500 mots.
    5. Inclut des mots-clés pertinents de manière naturelle et non forcée.
    6. Est informatif, engageant et apporte une réelle valeur ajoutée aux lecteurs.
    7. Utilise au maximum 3 listes à puces si nécessaire, un tableau, et une citation marquante et vérifiable au maximum et je veux une faq a chaque fois.
    8. Adopte un ton professionnel mais accessible, adapté à votre audience cible.
    9. Fait en sorte d'avoir du texte en quantité pour chaque paragraphe. Je n'ai pas envie que tu fasses un titre avec une phrase ; je veux du contenu de qualité.
    10. Mets les mots clés importants en gras dans le texte et humanise-le pour qu'il ne soit pas identifié comme généré par une IA.
    11. Je veux qu'il y ait au moins 5 H2 minimum. Si je ne te les ai pas fournis, je veux que tu les inventes, mais qu'ils restent cohérents et surtout je veux du vrai contenu au moin 3 ligne de text au minimum pour chaque sous titre le but est de faire un contenu seo qualitatif et de faire a peu pret 1500 mots. Et je veux obligatoirement des H3 (2, 3 ou 4) pour chaque H2, sauf pour la conclusion et la FAQ.
    12. Rend moi le contenu genérer sans aucun autre commentaire de ta part
    
    Fournis le contenu au format Markdown, en utilisant correctement les niveaux de titres (# pour H1, ## pour H2, ### pour H3).`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: "claude-3-haiku-20240307",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    });

    const generatedContent = response.data.content[0].text;

    // Sauvegarder l'article généré dans la base de données
    const article = new Article({
      userId: user._id,
      title: title || 'Article généré',
      content: generatedContent,
      url: url
    });
    await article.save();

    user.tokens -= 1;
    await user.save();

    res.json({ content: generatedContent, filename: `${title || 'contenu_seo'}.md`, tokens: user.tokens });
  } catch (error) {
    console.error('Error generating SEO content:', error);
    res.status(500).json({ error: 'Error generating SEO content' });
  }
});

app.get('/articles', authenticateToken, async (req, res) => {
  try {
    const articles = await Article.find({ userId: req.user._id })
      .select('title url createdAt')
      .sort({ createdAt: -1 });
    res.json(articles);
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Error fetching articles' });
  }
});

app.get('/article/:id', authenticateToken, async (req, res) => {
  try {
    const article = await Article.findOne({ _id: req.params.id, userId: req.user._id });
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.json({ content: article.content });
  } catch (error) {
    console.error('Error fetching article:', error);
    res.status(500).json({ error: 'Error fetching article' });
  }
});

app.post('/change-password', authenticateToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id);

    if (!(await user.comparePassword(currentPassword))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Error changing password' });
  }
});

app.post('/create-subscription-session', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { plan } = req.body;

    const planDetails = {
      basic: { price: process.env.STRIPE_PRICE_MONTHLY_100, name: 'Basic Plan' },
      pro: { price: process.env.STRIPE_PRICE_MONTHLY_500, name: 'Pro Plan' },
      enterprise: { price: process.env.STRIPE_PRICE_YEARLY_10000, name: 'Enterprise Plan' }
    };

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price: planDetails[plan].price,
        quantity: 1,
      }],
      mode: 'subscription',
      client_reference_id: user._id.toString(),
      customer_email: user.email,
      metadata: {
        plan: plan
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/create-token-purchase-session', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { quantity } = req.body;

    if (quantity < 25) {
      return res.status(400).json({ error: 'Minimum token purchase is 25' });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Tokens',
          },
          unit_amount: process.env.TOKEN_PRICE,
        },
        quantity: quantity,
      }],
      mode: 'payment',
      client_reference_id: user._id.toString(),
      customer_email: user.email,
      metadata: {
        tokens: quantity.toString(),
      },
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/subscription-status', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({
      plan: user.subscriptionPlan,
      status: user.subscriptionStatus,
      endDate: user.subscriptionEndDate
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/get-stripe-key', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

app.post('/stripe-webhook', async (req, res) => {
  console.log('Webhook Stripe reçu');
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Événement Stripe validé:', event.type);
  } catch (err) {
    console.error('Erreur de signature du webhook Stripe:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        const session = event.data.object;
        await handleCheckoutSessionCompleted(session);
        break;
      case 'invoice.paid':
        const invoice = event.data.object;
        await handleInvoicePaid(invoice);
        break;
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        await handleInvoicePaymentFailed(failedInvoice);
        break;
      case 'customer.subscription.deleted':
        const deletedSubscription = event.data.object;
        await handleSubscriptionDeleted(deletedSubscription);
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  } catch (error) {
    console.error('Erreur lors du traitement de l\'événement Stripe:', error);
    return res.status(500).send(`Error processing event: ${error.message}`);
  }

  res.json({received: true});
});

async function handleCheckoutSessionCompleted(session) {
  const userId = session.client_reference_id;
  const user = await User.findById(userId);
  if (!user) {
    console.error(`Utilisateur non trouvé pour l'ID: ${userId}`);
    return;
  }

  if (session.mode === 'payment') {
    const tokenQuantity = parseInt(session.metadata.tokens);
    await user.addTokens(tokenQuantity);
    console.log(`${tokenQuantity} tokens ajoutés pour l'utilisateur ${user.email}`);
  } else if (session.mode === 'subscription') {
    const plan = session.metadata.plan;
    await user.updateSubscription('active', plan, new Date(session.current_period_end * 1000));
    console.log(`Abonnement ${plan} activé pour l'utilisateur ${user.email}`);
  }
}

async function handleInvoicePaid(invoice) {
  const subscriptionId = invoice.subscription;
  const user = await User.findOne({ stripeCustomerId: invoice.customer });
  if (!user) {
    console.error(`Utilisateur non trouvé pour le client Stripe: ${invoice.customer}`);
    return;
  }

  const plan = invoice.lines.data[0].plan.nickname;
  await user.updateSubscription('active', plan, new Date(invoice.lines.data[0].period.end * 1000));
  
  let tokensToAdd = 0;
  switch (plan) {
    case 'basic':
      tokensToAdd = 100;
      break;
    case 'pro':
      tokensToAdd = 500;
      break;
    case 'enterprise':
      tokensToAdd = 10000;
      break;
  }
  await user.addTokens(tokensToAdd);
  console.log(`Abonnement renouvelé et ${tokensToAdd} tokens ajoutés pour l'utilisateur ${user.email}`);
}

async function handleInvoicePaymentFailed(invoice) {
  const user = await User.findOne({ stripeCustomerId: invoice.customer });
  if (!user) {
    console.error(`Utilisateur non trouvé pour le client Stripe: ${invoice.customer}`);
    return;
  }

  await user.updateSubscription('past_due', user.subscriptionPlan, user.subscriptionEndDate);
  console.log(`Statut d'abonnement mis à jour à 'past_due' pour l'utilisateur ${user.email}`);
}

async function handleSubscriptionDeleted(subscription) {
  const user = await User.findOne({ stripeCustomerId: subscription.customer });
  if (!user) {
    console.error(`Utilisateur non trouvé pour le client Stripe: ${subscription.customer}`);
    return;
  }

  await user.updateSubscription('canceled', null, null);
  console.log(`Abonnement annulé pour l'utilisateur ${user.email}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));