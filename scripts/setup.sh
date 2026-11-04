#!/bin/bash
set -e

echo "🚀 Setting up Apollo Route Manager..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ and try again."
    echo "   Download from: https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2)
MAJOR_VERSION=$(echo $NODE_VERSION | cut -d'.' -f1)

if [ "$MAJOR_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18 or higher is required. Current version: $NODE_VERSION"
    echo "   Please update Node.js and try again."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm and try again."
    exit 1
fi

# Check if PostgreSQL is running
if ! pg_isready &> /dev/null; then
    echo "⚠️  PostgreSQL is not running. Please start PostgreSQL and try again."
    echo "   On macOS with Homebrew: brew services start postgresql"
    echo "   On Ubuntu/Debian: sudo service postgresql start"
    exit 1
fi

echo "✅ Prerequisites check passed!"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Set up environment variables
if [ ! -f .env ]; then
    echo "🔧 Creating .env file from .env.example..."
    cp .env.example .env
    echo "   Please update the .env file with your configuration."
else
    echo "✅ .env file already exists. Skipping..."
fi

# Install Netlify CLI if not installed
if ! command -v netlify &> /dev/null; then
    echo "🌐 Installing Netlify CLI globally..."
    npm install -g netlify-cli
else
    echo "✅ Netlify CLI is already installed."
fi

# Install function dependencies
echo "📦 Installing netlify/functions dependencies..."
(cd netlify/functions && npm install)

echo "✨ Setup complete!"
echo ""
echo "Next steps:"
echo "1. Update the .env file (DB settings; flight search needs no keys)"
echo "2. Start the development server: npm run dev:clean"
echo "3. Open http://localhost:3000 in your browser"

echo "\nHappy coding! 🚀"
