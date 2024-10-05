require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const axios = require('axios');
const puppeteer = require('puppeteer'); // Ajout de Puppeteer pour le scraping

// Configuration de Mongoose
mongoose.set('strictQuery', false);

// Modèle utilisateur
const UserSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  credits: { type: Number, default: 0 }
});

const User = mongoose.model('User', UserSchema);

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
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.goto(url);

  // Scrape H1, H2, H3 et texte
  const h1 = await page.$eval('h1', el => el.innerText);
  const h2s = await page.$$eval('h2', els => els.map(el => el.innerText));
  const h3s = await page.$$eval('h3', els => els.map(el => el.innerText));
  const text = await page.evaluate(() => document.body.innerText);

  await browser.close();
  return { h1, h2s, h3s, text };
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
      const hashedPassword = await bcrypt.hash(password, 10);
      const user = new User({ email, password: hashedPassword });
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
    if (user && await bcrypt.compare(password, user.password)) {
      const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '24h' });
      res.json({ token });
    } else {
      res.status(400).json({ error: 'Invalid credentials' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/user', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select('-password');
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Nouvelle route pour la génération de contenu SEO
app.post('/generate', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (user.credits <= 0) {
      return res.status(403).json({ error: 'Insufficient credits' });
    }

    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Scraper les éléments SEO
    const { h1, h2s, h3s } = await scrapeSEOElements(url);

    const prompt = `En tant qu'expert en SEO et rédaction web, génère une variante de contenu basée sur ces éléments SEO :

H1 : ${h1}
H2s : ${h2s.join(', ')}
H3s : ${h3s.join(', ')}

Crée un article de blog optimisé pour le SEO qui :
Je ne veux pas que tu fasses un copier-coller. Je veux juste que tu t'inspires des titres pour en faire ta structure de texte. Ensuite, je veux que tu suives les règles suivantes pour rédiger le contenu :

1. Utilise ces éléments SEO de manière naturelle et pertinente.
2. A un contenu unique, original et approfondi.
3. Est structuré avec une introduction captivante, des sections pour chaque H2 (utilisées comme sous-titres), des sous-sections pour les H3 si pertinent, et une conclusion percutante.
4. Fait minimum 1200 mots.
5. Inclut des mots-clés pertinents de manière naturelle et non forcée.
6. Est informatif, engageant et apporte une réelle valeur ajoutée aux lecteurs.
7. Utilise au maximum 3 listes à puces si nécessaire, un tableau, et une citation marquante et vérifiable au maximum.
8. Adopte un ton professionnel mais accessible, adapté à votre audience cible.
9. Fait en sorte d'avoir du texte en quantité pour chaque paragraphe. Je n'ai pas envie que tu fasses un titre avec une phrase ; je veux du contenu de qualité.

Fournis le contenu au format Markdown, en utilisant correctement les niveaux de titres (# pour H1, ## pour H2, ### pour H3).`;

    const response = await axios.post('https://api.anthropic.com/v1/messages', {
      model: "claude-3-5-sonnet-20240620",
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

    user.credits -= 1;
    await user.save();

    res.json({ content: generatedContent, filename: 'contenu_seo.md' });
  } catch (error) {
    console.error('Error generating SEO content:', error);
    res.status(500).json({ error: 'Error generating SEO content' });
  }
});

// Gestion des erreurs
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));