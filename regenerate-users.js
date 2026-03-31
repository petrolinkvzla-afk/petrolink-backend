const bcrypt = require('bcryptjs');
const fs = require('fs');

const usersFile = 'users.json';
const hash = bcrypt.hashSync('admin123', 10);

const users = [
    {
        id: 1,
        company_id: 1,
        company_name: 'Energy Solutions Demo',
        email: 'admin@energy.com',
        password_hash: hash,
        full_name: 'Administrador Demo',
        role: 'admin',
        subscription_plan: 'pro',
        subscription_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        is_active: true,
        created_at: new Date().toISOString()
    },
    {
        id: 2,
        company_id: 1,
        company_name: 'Energy Solutions Demo',
        email: 'supervisor@energy.com',
        password_hash: hash,
        full_name: 'Supervisor Demo',
        role: 'supervisor',
        subscription_plan: 'pro',
        subscription_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        is_active: true,
        created_at: new Date().toISOString()
    },
    {
        id: 3,
        company_id: 1,
        company_name: 'Energy Solutions Demo',
        email: 'tecnico@energy.com',
        password_hash: hash,
        full_name: 'Técnico Demo',
        role: 'technician',
        subscription_plan: 'pro',
        subscription_expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        is_active: true,
        created_at: new Date().toISOString()
    },
    {
        id: 4,
        company_id: 2,
        company_name: 'Petrolinkvzla',
        email: 'pertrolinkvzla@gmail.com',
        password_hash: hash,
        full_name: 'Alex Serrano',
        role: 'admin',
        subscription_plan: 'free',
        subscription_expires_at: null,
        is_active: true,
        created_at: new Date().toISOString()
    }
];

fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
console.log('✅ Usuario regenerados:');
users.forEach(u => {
    console.log(`   ${u.email} / admin123 (${u.role})`);
});