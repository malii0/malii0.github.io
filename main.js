// main.js - Flash-free Dark/Light Mode Management

document.addEventListener("DOMContentLoaded", function() {

    // 1. Theme Toggle Butonunu Oluştur
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "theme-toggle";
    toggleBtn.className = "theme-btn";
    
    // İlk yüklemedeki ikon durumu
    const isLight = document.documentElement.classList.contains("light-mode") || document.body.classList.contains("light-mode");
    toggleBtn.innerHTML = isLight ? "☾" : "☀";
    toggleBtn.setAttribute("aria-label", "Toggle Dark/Light Mode");
    document.body.appendChild(toggleBtn);

    // HTML veya Body sınıf senkronizasyonu
    if (isLight) {
        document.body.classList.add("light-mode");
    }

    // 2. Tıklama Olayı
    toggleBtn.addEventListener("click", function() {
        const isCurrentlyLight = document.body.classList.toggle("light-mode");
        document.documentElement.classList.toggle("light-mode", isCurrentlyLight);

        if (isCurrentlyLight) {
            toggleBtn.innerHTML = "☾";
            localStorage.setItem("theme", "light");
        } else {
            toggleBtn.innerHTML = "☀";
            localStorage.setItem("theme", "dark");
        }
    });
});