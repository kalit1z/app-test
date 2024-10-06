const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true
  },
  password: {
    type: String,
    required: true
  },
  tokens: {
    type: Number,
    default: 5 // 5 tokens gratuits à l'inscription
  },
  stripeCustomerId: {
    type: String
  },
  subscriptionStatus: {
    type: String,
    enum: ['active', 'inactive', 'past_due', 'canceled'],
    default: 'inactive'
  },
  subscriptionPlan: {
    type: String
  },
  subscriptionEndDate: {
    type: Date
  },
  subscriptionIntent: {
    plan: String,
    timestamp: Date
  }
}, { timestamps: true });

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

userSchema.methods.updateSubscription = async function(status, plan, endDate) {
  this.subscriptionStatus = status;
  this.subscriptionPlan = plan;
  this.subscriptionEndDate = endDate;
  await this.save();
};

const User = mongoose.model('User', userSchema);

module.exports = User;