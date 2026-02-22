# ParaYield Lab - Simulation Backend

This is the simulation and aggregation backend for **ParaYield Lab**. It was built with NestJS and serves as the core engine for calculating APY, tracking historical vToken exchange rates, and running yield investment simulations across multiple protocols (Bifrost, Hydration, Moonwell).

---

## 🏗 System Architecture

The project contains the following main modules:
- **Indexer:** Fetches and synchronizes exchange rates and block data from the Bifrost RPC.
- **APY Calculator:** Computes 7D, 30D, and total farming APYs securely from historical rate snapshots.
- **Simulation Engine:** Proxies live pool data from the data server and runs "what-if" investment simulations using compound daily interest algorithms.

---

## 🚀 Quick Setup

### 1. Requirements
Ensure you have the following installed:
- Node.js (v18 or higher)
- pnpm (package manager)
- MongoDB (local or Atlas cluster)

### 2. Environment Variables
Create a `.env` file in the root directory (you can copy from `.env.example` if available) and configure it:

```env
# Server
PORT=3005
NODE_ENV=development

# Database
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/parayield-lab

# Security
ADMIN_API_KEY=your-secret-admin-key
JWT_SECRET=your-jwt-secret
ALLOWED_ORIGINS=http://localhost:3001,http://localhost:3000

# Rate Limiting
THROTTLE_TTL_MS=60000
THROTTLE_LIMIT=100

# External APIs
POOLS_API_URL=http://localhost:3000
```

### 3. Installation & Run
```bash
# Install dependencies
pnpm install

# Run the development server
pnpm run dev
```
The server will start on `http://localhost:3005`.

---

## 📖 API Documentation

The backend includes auto-generated Swagger documentation. Once the server is running, visit:
👉 **[http://localhost:3005/api/v1/api-docs](http://localhost:3005/api/v1/api-docs)**

### Key Simulation Endpoints

#### 1. Get Live Pools
`GET /api/v1/simulation/pools`
Fetches the current APY and TVL for pools across Bifrost, Moonwell, and Hydration. Supports querying by `protocol`, `network`, `limit`, and `sortBy`.

#### 2. Run Yield Simulation
`POST /api/v1/simulation/run`
Calculates compound yield over a specified date range with custom percentage allocations.

**Request Body Example:**
```json
{
  "initialAmountUsd": 10000,
  "from": "2026-01-01",
  "to": "2026-02-01",
  "allocations": [
    { "protocol": "hydration", "assetSymbol": "HOLLAR", "percentage": 60 },
    { "protocol": "hydration", "assetSymbol": "aDOT",   "percentage": 40 }
  ]
}
```

---

## � Testing

The Simulation engine is heavily unit-tested (including complex maths for leap years and zero APY anomalies).

```bash
# Run the test suite
pnpm run test
```

## 📜 License
This project is licensed under the MIT License.
