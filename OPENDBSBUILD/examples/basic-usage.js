const { OpenDBS } = require('../dist');

async function main() {
    console.log('🚀 OpenDBS Basic Usage Example\n');

    // Create database instance
    const db = new OpenDBS({
        path: './example-data',
        mode: 'nosql',
    });

    console.log('✓ Database instance created');

    // Create a database
    await db.createDatabase('myapp');
    console.log('✓ Database "myapp" created');

    // Create a rack (collection)
    await db.database('myapp').createRack('users');
    console.log('✓ Rack "users" created');

    // Insert documents
    console.log('\n📝 Inserting documents...');

    const user1 = await db.database('myapp').rack('users').insert({
        name: 'Alice Johnson',
        email: 'alice@example.com',
        age: 28,
        city: 'New York',
    });
    console.log('✓ Inserted user:', user1);

    const user2 = await db.database('myapp').rack('users').insert({
        name: 'Bob Smith',
        email: 'bob@example.com',
        age: 35,
        city: 'San Francisco',
    });
    console.log('✓ Inserted user:', user2);

    const user3 = await db.database('myapp').rack('users').insert({
        name: 'Charlie Brown',
        email: 'charlie@example.com',
        age: 42,
        city: 'Chicago',
    });
    console.log('✓ Inserted user:', user3);

    // Find all users
    console.log('\n🔍 Finding all users...');
    const allUsers = await db.database('myapp').rack('users').find({});
    console.log(`Found ${allUsers.length} users:`, allUsers);

    // Find users with age >= 30
    console.log('\n🔍 Finding users with age >= 30...');
    const olderUsers = await db.database('myapp').rack('users').find({
        age: { $gte: 30 },
    });
    console.log(`Found ${olderUsers.length} users:`, olderUsers);

    // Update a user
    console.log('\n✏️ Updating user...');
    await db.database('myapp').rack('users').update(user1.id, {
        name: 'Alice Johnson',
        email: 'alice.j@example.com', // Updated email
        age: 29, // Updated age
        city: 'New York',
    });
    console.log('✓ User updated');

    // Fuzzy search
    console.log('\n🔍 Fuzzy search for "Charle" (missing i)...');
    const fuzzyResults = await db.database('myapp').rack('users').fuzzySearch('name', 'Charle');
    console.log(`Found ${fuzzyResults.length} results:`, fuzzyResults);

    // Get stats
    console.log('\n📊 Database statistics:');
    const stats = await db.getStats();
    console.log(stats);

    console.log('\n✅ Example completed successfully!');
}

main().catch(console.error);
