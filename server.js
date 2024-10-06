require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const puppeteer = require('puppeteer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Import des modèles
const User = require('./models/User');
const Article = require('./models/Article');

// Configuration de Mongoose
mongoose.set('strictQuery', false);

const app = express();

// Middleware
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

// Fonction de scraping
const scrapeSEOElements = async (url) => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    headless: 'new'
  });
  const page = await browser.newPage();
  await page.goto(url);

  // Scrape H1, H2, H3, texte et titre de la page
  const h1 = await page.$eval('h1', el => el.innerText).catch(() => '');
  const h2s = await page.$$eval('h2', els => els.map(el => el.innerText)).catch(() => []);
  const h3s = await page.$$eval('h3', els => els.map(el => el.innerText)).catch(() => []);
  const text = await page.evaluate(() => document.body.innerText);
  const title = await page.title();

  await browser.close();
  return { h1, h2s, h3s, text, title };
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

// Nouvelles routes pour la gestion des abonnements

app.post('/create-subscription', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { priceId } = req.body;

    // Créer un client Stripe s'il n'existe pas déjà
    if (!user.stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
      });
      user.stripeCustomerId = customer.id;
      await user.save();
    }

    // Créer l'abonnement
    const subscription = await stripe.subscriptions.create({
      customer: user.stripeCustomerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    user.subscriptionId = subscription.id;
    user.subscriptionStatus = subscription.status;
    await user.save();

    res.json({
      subscriptionId: subscription.id,
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/cancel-subscription', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user.subscriptionId) {
      return res.status(400).json({ error: 'No active subscription' });
    }

    const subscription = await stripe.subscriptions.del(user.subscriptionId);

    user.subscriptionId = null;
    user.subscriptionStatus = 'canceled';
    await user.save();

    res.json({ message: 'Subscription canceled successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/upgrade-subscription', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { newPriceId } = req.body;

    if (!user.subscriptionId) {
      return res.status(400).json({ error: 'No active subscription to upgrade' });
    }

    const subscription = await stripe.subscriptions.retrieve(user.subscriptionId);
    
    await stripe.subscriptions.update(user.subscriptionId, {
      items: [{
        id: subscription.items.data[0].id,
        price: newPriceId,
      }],
    });

    res.json({ message: 'Subscription upgraded successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/buy-tokens', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    const { quantity } = req.body;

    if (quantity < 25) {
      return res.status(400).json({ error: 'Minimum token purchase is 25' });
    }

    const amount = quantity * 20; // 20 centimes par token

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: 'eur',
      customer: user.stripeCustomerId,
      metadata: { tokens: quantity },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/subscription-status', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    
    if (!user.subscriptionId) {
      return res.json({ status: 'No active subscription' });
    }

    const subscription = await stripe.subscriptions.retrieve(user.subscriptionId);
    res.json({
      status: subscription.status,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/stripe-webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      if (paymentIntent.metadata.tokens) {
        const user = await User.findOne({ stripeCustomerId: paymentIntent.customer });
        if (user) {
          user.tokens += parseInt(paymentIntent.metadata.tokens);
          await user.save();
          console.log(`Added ${paymentIntent.metadata.tokens} tokens to user ${user.email}`);
        }
      }
      break;
    case 'invoice.paid':
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      const user = await User.findOne({ subscriptionId: subscriptionId });
      if (user) {
        user.subscriptionStatus = 'active';
        // Ajouter les tokens en fonction du type d'abonnement
        if (invoice.lines.data[0].plan.amount === 2990) { // 29.90€ plan
          user.tokens += 100;
        } else if (invoice.lines.data[0].plan.amount === 9900) { // 99€ plan
          user.tokens += 500;
        } else if (invoice.lines.data[0].plan.amount === 99700) { // 997€ annual plan
          user.tokens += 10000;
        }
        await user.save();
        console.log(`Updated subscription status for user ${user.email} to active`);
      }
      break;
    case 'invoice.payment_failed':
      const failedInvoice = event.data.object;
      const failedSubscriptionId = failedInvoice.subscription;
      const failedUser = await User.findOne({ subscriptionId: failedSubscriptionId });
      if (failedUser) {
        failedUser.subscriptionStatus = 'past_due';
        await failedUser.save();
        console.log(`Updated subscription status for user ${failedUser.email} to past_due`);
      }
      break;
    case 'customer.subscription.deleted':
      const deletedSubscription = event.data.object;
      const deletedUser = await User.findOne({ subscriptionId: deletedSubscription.id });
      if (deletedUser) {
        deletedUser.subscriptionId = null;
        deletedUser.subscriptionStatus = 'canceled';
        await deletedUser.save();
        console.log(`Subscription canceled for user ${deletedUser.email}`);
      }
      break;
    // ... vous pouvez ajouter d'autres cas selon vos besoins

    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  // Return a response to acknowledge receipt of the event
  res.json({received: true});
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));