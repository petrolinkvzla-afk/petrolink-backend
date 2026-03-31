const bcrypt = require('bcryptjs');
const fs = require('fs');

const usersFile = 'users.json';
const hash = bcrypt.hashSync('admin123', 10);

// Verificar si el archivo existe
let users = [];
try {
    if (fs.existsSync(usersFile)) {
        users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
        console.log('Usuarios existentes:', users.length);
    }
} catch (error) {
    console.log('Error leyendo usuarios:', error.message);
}

// Asegurar que existe el usuario admin
const adminExists = users.find(u => u.email === 'admin@energy.com');
if (!adminExists) {
    users.push({
        id: users.length + 1,
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
    });
    console.log('✅ Usuario admin agregado');
}

// Asegurar que existe el supervisor
const supervisorExists = users.find(u => u.email === 'supervisor@energy.com');
if (!supervisorExists) {
    users.push({
        id: users.length + 1,
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
    });
    console.log('✅ Supervisor agregado');
}

// Asegurar que existe el técnico
const tecnicoExists = users.find(u => u.email === 'tecnico@energy.com');
if (!tecnicoExists) {
    users.push({
        id: users.length + 1,
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
    });
    console.log('✅ Técnico agregado');
}

// Guardar usuarios
fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
console.log('\n📋 USUARIOS DISPONIBLES:');
users.forEach(u => {
    console.log(`   ${u.email} / admin123 (${u.role})`);
});