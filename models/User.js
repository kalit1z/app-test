const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  tokens: { type: Number, default: 0 },
  stripeCustomerId: { type: String },
  stripeSubscriptionId: { type: String },
  stripePlanId: { type: String },
  subscriptionStatus: { type: String, enum: ['active', 'canceled', 'none'], default: 'none' },
  subscriptionEndDate: { type: Date }
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

userSchema.methods.addTokens = async function(amount) {
  this.tokens += amount;
  await this.save();
};

userSchema.methods.resetTokens = async function(amount) {
  this.tokens = amount;
  await this.save();
};

userSchema.methods.useToken = async function() {
  if (this.tokens > 0) {
    this.tokens -= 1;
    await this.save();
    return true;
  }
  return false;
};

userSchema.methods.setStripeCustomerId = async function(customerId) {
  this.stripeCustomerId = customerId;
  await this.save();
};

userSchema.methods.setSubscription = async function(subscriptionId, planId, endDate) {
  this.stripeSubscriptionId = subscriptionId;
  this.stripePlanId = planId;
  this.subscriptionStatus = 'active';
  this.subscriptionEndDate = endDate;
  await this.save();
};

userSchema.methods.cancelSubscription = async function() {
  this.subscriptionStatus = 'canceled';
  await this.save();
};

userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email });
};

const User = mongoose.model('User', userSchema);

module.exports = User;