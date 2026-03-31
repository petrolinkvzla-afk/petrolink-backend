const bcrypt = require('bcryptjs');
const fs = require('fs');

const email = process.argv[2] || 'pertrolinkvzla@gmail.com';
const newPassword = 'admin123';

const usersFile = 'users.json';
const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

const userIndex = users.findIndex(u => u.email === email);

if (userIndex === -1) {
    console.log(`❌ Usuario ${email} no encontrado`);
    console.log('Usuarios disponibles:');
    users.forEach(u => console.log(`   - ${u.email}`));
} else {
    const newHash = bcrypt.hashSync(newPassword, 10);
    users[userIndex].password_hash = newHash;
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    console.log(`✅ Contraseña restablecida para ${email}`);
    console.log(`   Nueva contraseña: ${newPassword}`);
}