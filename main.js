// main.js - Dark/Light Mode Yönetimi

document.addEventListener("DOMContentLoaded", function() {

    // 1. Butonu Oluştur
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "theme-toggle";
    toggleBtn.className = "theme-btn";
    toggleBtn.innerHTML = "☀"; // Varsayılan ikon (Karanlık moddayken Güneş çıkar)
toggleBtn.setAttribute("aria-label", "Toggle Dark/Light Mode");
document.body.appendChild(toggleBtn);

// 2. Hafızadaki Tercihi Kontrol Et
const currentTheme = localStorage.getItem("theme");

// Eğer hafızada "light" varsa uygula
if (currentTheme === "light") {
    document.body.classList.add("light-mode");
    toggleBtn.innerHTML = "☾"; // Ay ikonu
}

// 3. Tıklama Olayı
toggleBtn.addEventListener("click", function() {
    document.body.classList.toggle("light-mode");

    let theme = "dark";

    // Eğer light-mode sınıfı eklendiyse
    if (document.body.classList.contains("light-mode")) {
        theme = "light";
        toggleBtn.innerHTML = "☾"; // Geceye dönmek için Ay ikonu
    } else {
        toggleBtn.innerHTML = "☀"; // Gündüze dönmek için Güneş ikonu
    }

    // Tercihi kaydet
    localStorage.setItem("theme", theme);
});
});
