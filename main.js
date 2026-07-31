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

    // 5. Dynamic Cache-Busting via GitHub API for Static Assets (PDFs)
    const pdfLinks = document.querySelectorAll('a[href$=".pdf"]');

    pdfLinks.forEach(async (link) => {
        const rawHref = link.getAttribute('href').split('?')[0];
        const filePath = rawHref.startsWith('/') ? rawHref.slice(1) : rawHref;

        try {
            const response = await fetch(`https://api.github.com/repos/malii0/malii0.github.io/commits?path=${filePath}&page=1&per_page=1`);
            
            if (response.ok) {
                const data = await response.json();
                if (data.length > 0) {
                    const lastCommitDate = data[0].commit.committer.date.split('T')[0].replace(/-/g, '');
                    link.setAttribute('href', `${rawHref}?v=${lastCommitDate}`);
                }
            }
        } catch (error) {
            console.error(`Commit date query failed for: ${filePath}`, error);
        }
    });
});