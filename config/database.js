const mongoose = require('mongoose');

// Ajoutez cette ligne avant la fonction connectDB
mongoose.set('strictQuery', false); // ou true, selon votre préférence

const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI
      .replace('${DB_USER}', process.env.DB_USER)
      .replace('${DB_PASSWORD}', process.env.DB_PASSWORD);

    await mongoose.connect(uri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('MongoDB connected successfully');
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
};

module.exports = connectDB;