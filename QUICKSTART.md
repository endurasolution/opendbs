# OpenDBS Quick Start Guide

Welcome to **OpenDBS**! This guide will help you get started in minutes.

> **New Features**: 
> - AI Dataset Management (Section 8)
> - **Unified SQL + NoSQL on Port 4402** (Section 10)
> - Typed Racks with Schema Support (Section 3)

**Architecture**: OpenDBS now runs on a **single port (4402)** with both SQL and NoSQL support. You can create racks as either `sql` or `nosql` type, with automatic type enforcement.

## 🚀 Quick Setup

### 1. Prerequisites

Ensure you have the following installed:
- **Node.js** 18+ ([download](https://nodejs.org/))
- **Rust** 1.70+ ([install](https://rustup.rs/))
- **npm** or **yarn**

### 2. Installation

```bash
# Clone the repository (if not already)
git clone https://github.com/endurasolution/opendbs.git
cd opendbs

# Install Node.js dependencies
npm install

# Copy environment configuration
cp .env.example .env

# Build TypeScript
npm run build:ts
```

### 3. Start the Server

```bash
# Development mode with hot reload
npm run dev

# Production mode
npm run build
npm start
```

The server will start on `http://localhost:4402`

**⚠️ IMPORTANT**: On first startup, a default admin account will be created:
- **Username**: `admin`
- **Password**: `admin123`
- **API Key**: Will be displayed in console

**Please change the password immediately!**

---

## 🔐 Authentication

OpenDBS supports **two authentication methods**:

### Method 1: JWT Token (Username + Password)

```bash
# Login to get JWT token
curl -X POST http://localhost:4402/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "admin123"
  }'

# Response:
# {
#   "message": "Login successful",
#   "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
#   "user": { ... }
# }
```

### Method 2: API Key

```bash
# Use API key directly (shown on first startup or regenerate)
curl -X GET http://localhost:4402/api/databases \
  -H "x-api-key: opendbs_abc123..."
```

---

## 📝 Usage Guide

### 1. Login and Get Token

```bash
# Login
curl -X POST http://localhost:4402/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "password": "admin123"
  }' | jq -r '.token' > token.txt

# Save token for later use
TOKEN=$(cat token.txt)
```

### 2. Create a Database

```bash
curl -X POST http://localhost:4402/api/databases \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "myapp"}'

# List all your databases
curl http://localhost:4402/api/databases \
  -H "Authorization: Bearer $TOKEN"

# List databases with their racks
curl "http://localhost:4402/api/databases?include_racks=true" \
  -H "Authorization: Bearer $TOKEN"
```

### 3. Create a Rack (Collection)

Racks can be created as **`sql`** or **`nosql`** type with optional schema:

#### NoSQL Rack (Default - accepts both SQL and NoSQL operations)
```bash
curl -X POST http://localhost:4402/api/databases/myapp/racks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "users",
    "type": "nosql"
  }'
```

#### SQL Rack (Only accepts SQL operations)
```bash
curl -X POST http://localhost:4402/api/databases/myapp/racks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "products",
    "type": "sql",
    "schema": {
      "name": {"type": "string", "required": true},
      "price": {"type": "number", "required": true},
      "inStock": {"type": "boolean"}
    }
  }'
```

**Type Enforcement Rules:**
- **SQL racks**: Can ONLY accept SQL operations (via `/api/sql/:db/execute`)
- **NoSQL racks**: Can accept BOTH NoSQL (via `/api/databases/:db/racks/:rack/documents`) AND SQL operations

**Schema Types**: `string`, `number`, `boolean`, `date`, `array`, `object`

### 4. Insert Documents

OpenDBS supports both **NoSQL** and **SQL** insertion depending on your rack type.

#### NoSQL Insert (JSON Documents)
Works on **NoSQL racks** only:

```bash
# Single document insert
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "age": 30,
    "city": "New York"
  }'

# Batch insert multiple documents
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '[
    {"name": "Alice", "email": "alice@example.com", "age": 25},
    {"name": "Bob", "email": "bob@example.com", "age": 35}
  ]'
```

#### SQL Insert
Works on **both SQL and NoSQL racks**:

```bash
# Single row insert
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "INSERT INTO users (name, email, age) VALUES ('\''John Doe'\'', '\''john@example.com'\'', 30)"
  }'

# Multiple inserts
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "INSERT INTO users (name, email) VALUES ('\''Alice'\'', '\''alice@example.com'\'')"
  }'
```

**Note**: If you try NoSQL insert on a SQL rack, you'll get an error: `"Rack 'name' is of type SQL and cannot accept NoSQL operations"`

---

### 5. Query and Search Documents

OpenDBS offers powerful search capabilities ranging from simple filters to advanced regex and fuzzy matching.

#### Basic Filtering (NoSQL)

Query by exact field match using URL parameters:

```bash
# Get all users
curl http://localhost:4402/api/databases/myapp/racks/users/documents \
  -H "Authorization: Bearer $TOKEN"

# Query by age
curl "http://localhost:4402/api/databases/myapp/racks/users/documents?age=30" \
  -H "Authorization: Bearer $TOKEN"

# Query by multiple fields
curl "http://localhost:4402/api/databases/myapp/racks/users/documents?city=New%20York&age=30" \
  -H "Authorization: Bearer $TOKEN"
```

#### SQL SELECT Queries

Same queries using SQL syntax:

```bash
# Get all users
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "SELECT * FROM users"
  }'

# Query by age
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "SELECT * FROM users WHERE age = '\''30'\''"
  }'

# Query by multiple fields
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "SELECT * FROM users WHERE city = '\''New York'\'' AND age = '\''30'\''"
  }'
```

#### Advanced Search (Range & Operators)

Use the POST `/search` endpoint for complex queries with operators like `$gt`, `$lt`, `$in`, etc.

```bash
# Find users aged 25 to 35
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": {
      "age": { "$gte": 25, "$lte": 35 }
    }
  }'

# Find users in specific cities
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": {
      "city": { "$in": ["New York", "London"] }
    }
  }'
```

**Supported Operators:**
- `$eq`: Equal
- `$ne`: Not equal
- `$gt`: Greater than
- `$gte`: Greater than or equal
- `$lt`: Less than
- `$lte`: Less than or equal
- `$in`: In array
- `$nin`: Not in array
- `$regex`: Regular expression match
- `$exists`: Check if field exists

#### Range Search (Convenience Endpoint)

```bash
# Find products between $50 and $200
curl -X POST http://localhost:4402/api/databases/myapp/racks/products/search/range \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "field": "price",
    "min": 50,
    "max": 200
  }'
```

#### Pattern Matching (Regex)

Search using regular expressions. Great for finding emails, codes, or names starting with specific letters.

```bash
# Find emails ending with @example.com
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/search/pattern \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "field": "email",
    "pattern": "@example\\.com$"
  }'

# Find names starting with "J" or "K"
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/search/pattern \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "field": "name",
    "pattern": "^[JK]"
  }'
```

#### Fuzzy Search

Find fuzzy matches (e.g., spelling mistakes or approximate matches).

```bash
# Find "John" even if searched as "Jon" or "Jhn"
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/search/fuzzy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "field": "name",
    "query": "Jon Doe",
  }'
```

#### Vector Search (Semantic Search)

Perform similarity search using vectors (embeddings). This allows for semantic search if you generate embeddings for your data.

1. **Insert Data with Vectors**:
```bash
curl -X POST http://localhost:4402/api/databases/myapp/racks/products/documents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Smart Watch",
    "description": "Wearable technology...",
    "embedding": [0.1, 0.5, 0.8, -0.2]
  }'
```

2. **Search with Query Vector**:
```bash
# Find products similar to the vector [0.1, 0.4, 0.9, -0.1]
curl -X POST http://localhost:4402/api/databases/myapp/racks/products/search/vector \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "field": "embedding",
    "vector": [0.1, 0.4, 0.9, -0.1],
    "k": 5
  }'
```

The response includes a `_metadata.score` field showing the cosine similarity (1.0 is exact match).

#### Indexing (Faster Queries)

Improve query performance by indexing frequently searched fields. OpenDBS supports exact-match indexing.

```bash
# Create an index on 'email' field
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/indexes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"field": "email"}'
```

Once indexed, queries filtering by `email` will be significantly faster (O(1) lookup instead of O(N) scan). Indices are automatically updated on insert, update, and delete.

---

### 6. Relations & Foreign Keys (Joins)

OpenDBS allows you to link documents between different racks using "Foreign Keys".

**Format**: `rack_name:document_id`

#### 1. Create Data in Reference Rack (e.g., 'profiles')

```bash
# Create profiles rack
curl -X POST http://localhost:4402/api/databases/myapp/racks \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "profiles"}'

# Insert a profile (ID will be generated, e.g., "1")
curl -X POST http://localhost:4402/api/databases/myapp/racks/profiles/documents \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"bio": "Software Engineer", "github": "johndoe"}'
```

#### 2. Create Data with Foreign Key

```bash
# Insert user referencing the profile ("profiles:1")
curl -X POST http://localhost:4402/api/databases/myapp/racks/users/documents \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Doe",
    "email": "john@example.com",
    "profile_id": "profiles:1"
  }'
```

#### 3. Query with Populate

Add `?populate=true` to automatically resolve the reference.

```bash
curl "http://localhost:4402/api/databases/myapp/racks/users/documents?populate=true" \
  -H "Authorization: Bearer $TOKEN"
```

**Result:**
```json
{
  "results": [
    {
      "id": "2",
      "name": "John Doe",
      "email": "john@example.com",
      "profile_id": {
        "id": "1",
        "bio": "Software Engineer",
        "github": "johndoe"
      }
    }
  ]
}
```

---

### 7. Data Management (Delete & Clear)

Manage your data efficiently with delete and clear operations.

#### Update Documents

**NoSQL Update:**
```bash
# Update document with ID "123"
curl -X PUT http://localhost:4402/api/databases/myapp/racks/users/documents/123 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "John Updated",
    "email": "john.new@example.com",
    "age": 31
  }'
```

**SQL Update:**
```bash
# Update using SQL
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "UPDATE users SET email = '\''john.new@example.com'\'', age = '\''31'\'' WHERE id = '\''123'\''"
  }'
```

#### Delete a Single Document

**NoSQL Delete:**
```bash
# Delete document with ID "123"
curl -X DELETE http://localhost:4402/api/databases/myapp/racks/users/documents/123 \
  -H "Authorization: Bearer $TOKEN"
```

**SQL Delete:**
```bash
# Delete using SQL
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "DELETE FROM users WHERE id = '\''123'\''"
  }'
```

#### Clear All Documents in a Rack
Removes all documents but keeps the rack definition.

```bash
curl -X DELETE http://localhost:4402/api/databases/myapp/racks/users/clear \
  -H "Authorization: Bearer $TOKEN"
```

#### Delete a Rack
Deletes a rack and all its documents permanently.

```bash
curl -X DELETE http://localhost:4402/api/databases/myapp/racks/users \
  -H "Authorization: Bearer $TOKEN"
```

#### Delete a Database
Deletes a database and all its racks permanently.

```bash
curl -X DELETE http://localhost:4402/api/databases/myapp \
  -H "Authorization: Bearer $TOKEN"
```

---

---

### 8. AI Dataset Management

OpenDBS provides specialized tools for capturing and managing AI datasets, including bulk ingestion and versioning (snapshotting).

#### Create a Dataset
A dataset is a specialized rack.

```bash
curl -X POST http://localhost:4402/api/ai/datasets/myapp/training_data \
  -H "Authorization: Bearer $TOKEN"
```

#### Bulk Ingest Data
Efficiently load large JSON arrays into your dataset.

```bash
# Load data from local JSON file
curl -X POST http://localhost:4402/api/ai/datasets/myapp/training_data/ingest \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @./my-dataset.json
```

#### Versioning (Snapshots)
Create immutable snapshots of your datasets for different training experiments.

```bash
# Create a snapshot tagged 'v1' -> creates 'training_data_v1'
curl -X POST http://localhost:4402/api/ai/datasets/myapp/training_data/snapshot \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"versionTag": "v1"}'
```

#### Export Dataset
Get your data back for training.

```bash
curl http://localhost:4402/api/ai/datasets/myapp/training_data_v1/export \
  -H "Authorization: Bearer $TOKEN" > dataset_v1.json
```

---

---

### 9. Backup & Restore

OpenDBS provides comprehensive backup and restore capabilities with support for local storage, S3, and FTP.

#### Create Manual Backup

Role-based backups:
- **Admin**: Backs up all databases and system data
- **User**: Backs up only databases they have access to

```bash
# Create a backup
curl -X POST http://localhost:4402/api/backup/create \
  -H "Authorization: Bearer $TOKEN"
```

#### List Available Backups

```bash
curl http://localhost:4402/api/backup/list \
  -H "Authorization: Bearer $TOKEN"
```

#### Restore from Backup (Admin Only)

```bash
curl -X POST http://localhost:4402/api/backup/restore \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"backupName": "backup_full_2026-01-26T12-00-00.tar.gz"}'
```

#### Quick Backup (JSON Export)

Easily export your data as JSON (for racks) or a ZIP of JSON files (for databases).

**Backup a specific rack (JSON download):**
```bash
curl "http://localhost:4402/api/backup/quick?database=myapp&rack=users" \
  -H "Authorization: Bearer $TOKEN" \
  --output users.json
```

**Backup an entire database (ZIP download):**
```bash
curl "http://localhost:4402/api/backup/quick?database=myapp" \
  -H "Authorization: Bearer $TOKEN" \
  --output myapp_backup.zip
```

#### Scheduled Backups

Configure automated backups in `.env`:

```env
# Enable scheduled backups
BACKUP_ENABLED=true
BACKUP_PATH=./backups
BACKUP_SCHEDULE=0 2 * * *
BACKUP_RETENTION_DAYS=7

# Storage backend
BACKUP_TYPE=local

# S3 Configuration (optional)
BACKUP_S3_BUCKET=my-backup-bucket
BACKUP_S3_REGION=us-east-1
BACKUP_S3_ACCESS_KEY=your_access_key
BACKUP_S3_SECRET_KEY=your_secret_key

# FTP Configuration (optional)
BACKUP_FTP_HOST=ftp.example.com
BACKUP_FTP_PORT=21
BACKUP_FTP_USER=backup_user
BACKUP_FTP_PASSWORD=backup_password
```

**Cron Schedule Format**:
- `0 2 * * *` - Daily at 2:00 AM
- `0 */6 * * *` - Every 6 hours
- `0 0 * * 0` - Every Sunday at midnight
- `*/30 * * * *` - Every 30 minutes

---

## 👥 User Management (Admin Only)

### Create a New User

```bash
curl -X POST http://localhost:4402/api/auth/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{
    "username": "developer",
    "password": "secure_password",
    "role": "user",
    "permissions": {
      "myapp": ["read", "write"],
      "testdb": ["read"]
    }
  }'
```

### List All Users

```bash
curl http://localhost:4402/api/auth/users \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

### 10. SQL Support (MySQL Compatible)

OpenDBS supports SQL queries alongside NoSQL operations on a **unified port (4402)**!

#### Architecture

- **Single Port**: `4402` handles BOTH SQL and NoSQL operations
- **Typed Racks**: Create racks as `sql` or `nosql` type
- **Type Enforcement**: 
  - SQL racks accept ONLY SQL operations
  - NoSQL racks accept BOTH SQL and NoSQL operations

#### Generate SQL Credentials

Each user gets unique SQL username/password:

```bash
# Generate SQL credentials for your account
curl -X POST http://localhost:4402/api/sql/credentials \
  -H "Authorization: Bearer $TOKEN"

# Response:
{
  "credentials": {
    "username": "opendbs_admin",
    "password": "xY9$kL2@mN4pQ8rT",
    "host": "localhost",
    "port": 3306,
    "connectionString": "mysql://opendbs_admin:xY9$...@localhost:3306/"
  }
}
```

#### Complete SQL CRUD Examples

**CREATE TABLE (Creates SQL Rack with Schema):**
```bash
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "CREATE TABLE products (id INT, name VARCHAR(255) NOT NULL, price DECIMAL, inStock BOOLEAN)"
  }'
```

**INSERT (Works on SQL or NoSQL racks):**
```bash
# Single insert
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "INSERT INTO products (name, price, inStock) VALUES ('\''Laptop'\'', 999.99, true)"
  }'

# Another insert
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "INSERT INTO products (name, price, inStock) VALUES ('\''Mouse'\'', 25.50, true)"
  }'
```

**SELECT (Query Data):**
```bash
# Get all products
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "SELECT * FROM products"
  }'

# Filter by condition
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "SELECT * FROM products WHERE price > '\''100'\'' OR inStock = true"
  }'
```

**UPDATE (Modify Data):**
```bash
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "UPDATE products SET price = '\''899.99'\'' WHERE id = '\''1'\''"
  }'
```

**DELETE (Remove Data):**
```bash
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "DELETE FROM products WHERE id = '\''2'\''"
  }'
```

**DROP TABLE (Delete Rack):**
```bash
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "DROP TABLE products"
  }'
```

#### Mixing SQL and NoSQL

**Example: NoSQL Rack accepts both**
```bash
# Create NoSQL rack
curl -X POST http://localhost:4402/api/databases/myapp/racks \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "flexible_data", "type": "nosql"}'

# Insert via NoSQL ✅
curl -X POST http://localhost:4402/api/databases/myapp/racks/flexible_data/documents \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name": "Alice", "role": "admin"}'

# Insert via SQL ✅ (also works!)
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "query": "INSERT INTO flexible_data (name, role) VALUES ('\''Bob'\'', '\''user'\'')"
  }'
```

**Example: SQL Rack blocks NoSQL**
```bash
# Create SQL rack
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -d '{"query": "CREATE TABLE strict_data (id INT, value VARCHAR(50))"}'

# Insert via SQL ✅
curl -X POST http://localhost:4402/api/sql/myapp/execute \
  -d '{"query": "INSERT INTO strict_data (value) VALUES ('\''test'\'')"}'

# Insert via NoSQL ❌ (blocked!)
curl -X POST http://localhost:4402/api/databases/myapp/racks/strict_data/documents \
  -d '{"value": "test"}'
# Error: "Rack 'strict_data' is of type SQL and cannot accept NoSQL operations"
```

---

## 🔧 Configuration

Edit `.env` file to configure OpenDBS:

```env
# Server
PORT=3001
HOST=0.0.0.0

# Database
DB_PATH=./data
DB_MODE=nosql

# Security (CHANGE THESE IN PRODUCTION!)
JWT_SECRET=your-super-secret-jwt-key
API_KEY_SALT=your-api-key-salt

# Performance
MAX_CONNECTIONS=1000
ENABLE_COMPRESSION=true

# Search
ENABLE_FUZZY_SEARCH=true
ENABLE_SEMANTIC_SEARCH=true
```

---

##  Next Steps

1. ✅ **Read the [Architecture Documentation](docs/ARCHITECTURE.md)**
2. ✅ **Explore [Examples](examples/)**
3. ✅ **Check the [Authentication Guide](AUTHENTICATION.md)**
4. ✅ **Contribute! See [CONTRIBUTING.md](CONTRIBUTING.md)**

---

## 🆘 Getting Help

- 📖 **Documentation**: [docs.opendbs.org](https://docs.opendbs.org)
- 💬 **Discord**: [Join our community](https://discord.gg/opendbs)
- 📧 **Email**: support@opendbs.org

---

**Happy Coding! 🚀**
