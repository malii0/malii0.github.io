// main.js - OS Preference & Storage Aware Dark/Light Mode

document.addEventListener("DOMContentLoaded", function() {

    // 1. Durum Tespiti (localStorage > OS Tercihi > Dark Default)
    const storedTheme = localStorage.getItem("theme");
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    const isLight = storedTheme ? storedTheme === "light" : prefersLight;

    // 2. Class senkronizasyonu
    if (isLight) {
        document.body.classList.add("light-mode");
        document.documentElement.classList.add("light-mode");
    }

    // 3. Theme Toggle Butonunu Oluştur
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "theme-toggle";
    toggleBtn.className = "theme-btn";
    toggleBtn.innerHTML = isLight ? "☾" : "☀";
    toggleBtn.setAttribute("aria-label", "Toggle Dark/Light Mode");
    toggleBtn.setAttribute("aria-pressed", isLight ? "true" : "false");
    document.body.appendChild(toggleBtn);

    // 4. Tıklama Olayı
    toggleBtn.addEventListener("click", function() {
        const isCurrentlyLight = document.body.classList.toggle("light-mode");
        document.documentElement.classList.toggle("light-mode", isCurrentlyLight);

        toggleBtn.setAttribute("aria-pressed", isCurrentlyLight ? "true" : "false");

        if (isCurrentlyLight) {
            toggleBtn.innerHTML = "☾";
            localStorage.setItem("theme", "light");
        } else {
            toggleBtn.innerHTML = "☀";
            localStorage.setItem("theme", "dark");
        }
    });
});
