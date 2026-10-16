# Fish Audio Drama 3 — génération FP8 avec experts en RAM

Depuis **v0.10.0**, le studio installe et utilise un moteur Drama 3 distinct de S2. Le profil communautaire FP8/BF16 garde les experts routés en RAM et limite leur cache GPU à **4 Gio**. Le codec FP32 est utilisé avant puis après le modèle ; il ne reste pas chargé sur le GPU pendant la génération des codes. Built with Fish Audio.

## Installation sur RTX 5060 Ti 16 Go + 64 Go de RAM

1. Choisir le dossier dans **Paramètres → Stockage des modèles**. Prévoir environ **60 Go libres** à la première installation, sur un SSD si possible. Les poids et le codec représentent **40 144 065 412 octets**, soit 37,39 Gio ; le runtime Python/CUDA et ses archives s’ajoutent à ce total.
2. Ouvrir **Modèles**, trouver **Fish Audio Drama 3 · FP8 · experts en RAM**, puis installer cette variante. Les téléchargements utilisent des révisions, tailles et SHA-256 fixés. La vérification peut durer, particulièrement pour le fichier de 38,6 Go. Le bouton Annuler et les logs restent disponibles ; un nouvel essai réutilise les fichiers complets vérifiés.
3. Fermer les autres moteurs IA et applications gourmandes. Le profil exige au moins **46 Gio de RAM disponible**, **12 Gio de VRAM libre** et une machine de la classe 64 Go de RAM.
4. Dans **Doublage**, choisir Drama 3 et le GPU NVIDIA. « Automatique » choisit le premier GPU CUDA visible ; le Ryzen iGPU n’est pas un périphérique CUDA. Un choix `cuda:N` conserve ce GPU pendant toutes les étapes. Il n’y a pas de génération de secours sur CPU.

Le moteur utilise PyTorch 2.8.0 avec CUDA 12.8 et les experts FP8 sont déquantifiés en BF16 à l’utilisation. Il ne dépend pas des noyaux de quantification optimisés CUDA 13 de Comfy Kitchen. Un avertissement Comfy sur ces noyaux ne signifie donc pas que la génération BF16 a échoué.

![Installation Drama 3](screenshots/drama3-install.png)

## Générer une réplique

1. Saisir le texte traduit, puis ouvrir **Doubler** sur la réplique.
2. Choisir **Fish Audio Drama 3 · FP8 · experts en RAM** et la RTX.
3. Choisir une référence vocale de **1 à 20 secondes**, propre et sans musique si possible. La piste d’extraction reste celle choisie dans Audio, par défaut Voix. Une référence française peut mieux guider l’accent français.
4. Fournir **la transcription exacte de toute la référence**, dans sa langue d’origine. Pour une référence de personnage, utiliser **Transcrire la référence** puis vérifier le résultat. Drama 3 n’utilise pas le mode sans transcription ; la traduction française d’une référence japonaise ne remplace pas son texte japonais exact.
5. Choisir l’humeur, la vitesse et la graine, puis **Générer un nouvel essai**. La consigne d’humeur est une indication au modèle, sans résultat garanti. Les logs montrent le chargement, les morceaux de texte et les trames audio générées.
6. Écouter et choisir l’essai. Le WAV mono 24 kHz rejoint les outils existants : déplacement et durée sur la timeline, ajustement automatique, mixage avec les pistes, retouche des lèvres et export MKV.

![Génération Drama 3](screenshots/drama3-generation.png)

Ces captures montrent la véritable interface React dans Chrome, avec inventaire CUDA et fin de génération simulés pour les tests ; elles ne montrent pas un résultat du modèle complet.

## Temps de calcul et mémoire

Le premier chargement lit environ 38,6 Go de poids et prépare les banques d’experts en RAM. Cela peut prendre plusieurs minutes. Le modèle et le codec sont libérés à la fin de la tâche. La séparation RAM/GPU économise la VRAM, mais ajoute des transferts PCIe ; ne pas attendre les temps de S2. La tâche est limitée à une heure, environ 28 secondes par morceau de texte et 120 secondes de sortie au total ; une limite de trames atteinte rejette la prise tronquée.

Le cache de 4 Gio est réduit si la mémoire libre et les couches à charger l’exigent. Une réserve GPU de 2 Gio est demandée. La construction du modèle sur `meta` puis l’assignation des poids évitent une seconde copie complète en RAM. Ces protections ne constituent pas une garantie de consommation mesurée sur la RTX 5060 Ti.

Le poste de développement n’a pas de GPU NVIDIA et ne peut pas charger les poids complets. Les tests Windows CPU vérifient le calcul FP8, les banques RAM, les évictions du cache, une génération autorégressive avec un modèle réduit et les 1 367 noms/formes de tenseurs des en-têtes réels. **Vitesse, pic mémoire et qualité française du modèle complet restent à mesurer sur votre machine.** Voir [VALIDATION.md](../VALIDATION.md).

Si une prise se tait ou s’interrompt, vérifier que la transcription couvre tout l’extrait, utiliser une référence différente puis une autre graine. L’auteur du chargeur signale ce comportement possible avec certaines références.

## Sources, variantes et licences

- [Modèle Fish Audio Drama 3](https://huggingface.co/fishaudio/drama-3) : MoE d’environ 35B, environ 3B actifs ; le runtime officiel annonce au moins 48 Go de VRAM.
- [Chargeur ComfyUI-Drama3](https://github.com/PedroMarinhoDev/ComfyUI-Drama3), révision `66c4fb9cd3c0151e1e2ccd207847cb8335e87ab4`, avec adaptation de chargement documentée. Utilisé sans serveur ni installation préalable de ComfyUI.
- [Poids convertis FP8 et codec](https://huggingface.co/PedroMarinhoDev/Drama-3-ComfyUI), révision `9063c072019aa578895e51adb5489c6cd2c834b0` ; tailles et SHA-256 dans `workers/voice-engines.json`.
- ComfyUI 0.40.0, révision `3541246a9c997f4b8c32f9f88f3c985d02021c79`. Source et licence du cœur distribuées dans `workers/vendor/drama3/comfy-core.zip` ; dépendances Windows isolées et vérifiées dans `workers/drama-runtime.json`.

Les variantes officielles FP8, INT4/SGLang-Omni, W6A8 et W4A8 restent **référencées sans moteur de génération intégré**. Aucun moteur GGUF Drama 3 n’est annoncé utilisable ici. Les installations S2 restent séparées.

Consulter la [Fish Audio Community License 1.0](https://huggingface.co/fishaudio/drama-3/blob/main/LICENSE) pour les poids, composants Fish et sorties. Le chargeur et le cœur Comfy sont sous GPL-3.0 avec exceptions décrites par leurs notices ; le source correspondant et les licences sont fournis avec l’application. Les poids sont téléchargés sur demande et ne sont inclus dans aucune archive de distribution.
