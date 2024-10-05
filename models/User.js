const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  credits: { type: Number, default: 0 },
  stripeCustomerId: { type: String }
});

userSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.generateAuthToken = function() {
  return jwt.sign({ _id: this._id }, process.env.JWT_SECRET, { expiresIn: '1d' });
};

userSchema.methods.addCredits = async function(amount) {
  this.credits += amount;
  await this.save();
};

userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email });
};

userSchema.methods.setStripeCustomerId = async function(customerId) {
  this.stripeCustomerId = customerId;
  await this.save();
};

const User = mongoose.model('User', userSchema);

module.exports = User;