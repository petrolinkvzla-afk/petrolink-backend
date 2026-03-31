const bcrypt = require('bcryptjs');
const fs = require('fs');

const usersFile = 'users.json';
const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

// Encontrar al usuario
const userIndex = users.findIndex(u => u.email === 'pertrolinkvzla@gmail.com');

if (userIndex === -1) {
    console.log('Usuario no encontrado');
} else {
    // Agregar campo is_active si no existe
    if (users[userIndex].is_active === undefined) {
        users[userIndex].is_active = true;
    }
    
    // Resetear contraseña con un hash nuevo
    const newPassword = 'admin123';
    const newHash = bcrypt.hashSync(newPassword, 10);
    users[userIndex].password_hash = newHash;
    
    console.log('✅ Usuario actualizado:');
    console.log(`   ID: ${users[userIndex].id}`);
    console.log(`   Email: ${users[userIndex].email}`);
    console.log(`   Nombre: ${users[userIndex].full_name}`);
    console.log(`   Rol: ${users[userIndex].role}`);
    console.log(`   Activo: ${users[userIndex].is_active}`);
    console.log(`   Nueva contraseña: ${newPassword}`);
    console.log(`   Hash: ${newHash}`);
    
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
    console.log('\n✅ Archivo users.json actualizado correctamente');
}