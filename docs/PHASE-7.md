# Phase 7 — écoute synchronisée, mix et export MKV

La version **0.7.0** ajoute la piste **Doublage** à la timeline et au mixeur. Elle lit les essais sélectionnés pour la langue cible du projet avec la vidéo, puis exporte le montage dans un conteneur Matroska.

## Écouter le doublage

1. Importez vos SRT, corrigez les associations et générez des essais depuis **Doubler**. Choisissez l’essai à retenir pour chaque réplique.
2. Pour conserver la musique et les effets sans les voix originales, lancez la séparation Bandit depuis **Audio**.
3. Cliquez sur **Préparer le mix de doublage**, au-dessus du lecteur ou dans **Audio**. Cette commande active le doublage, la musique et les effets, coupe l’audio original et la piste Voix de Bandit, et remet les solos à zéro. Elle conserve vos volumes et vos zones.
4. Appuyez sur **Lecture**. Les prises commencent au début actuel de leur réplique. Déplacement dans la vidéo, pause et boucle restent synchronisés. Le lecteur charge les prises proches de la tête de lecture avant de commencer ; il conserve un cache limité.
5. Ajustez le volume, le silence ou le solo de **Doublage**, **Musique** et **Effets** dans **Audio**. Les commandes rapides et les zones de volume/silence fonctionnent aussi sur Doublage. Un bloc dans la timeline représente chaque prise sélectionnée, avec sa durée sonore.

Les prises gardent leur durée naturelle. Une prise trop longue peut déborder sur la suivante ; les voix qui se chevauchent sont additionnées. L’application ne fait pas de raccourcissement ou de time-stretch automatique en phase 7 : corrigez le texte, la vitesse de génération ou les repères si nécessaire. Le son est coupé à la fin du média.

L’écoute A/B d’un essai WAV reste indépendante et met la vidéo en pause. **Original / O** permet une écoute temporaire de l’audio original sans modifier les réglages enregistrés du mix. **Lecture** revient au mix. À vitesse accélérée, les prises Web Audio changent aussi de hauteur ; évaluez la voix à vitesse normale.

## Exporter le MKV

Ouvrez **Exporter**. Le panneau indique le nombre de prises, les pistes audibles et les éléments à vérifier. Les répliques traduites sans prise, les prises modifiées depuis leur génération et les prises dépassant leur créneau demandent une autorisation explicite d’export incomplet. Une prise provenant d’un autre média ou d’une autre langue ne remplace pas une prise manquante.

- **Vidéo :** flux vidéo original copié sans réencodage, depuis le média importé et jamais depuis le proxy de prévisualisation.
- **Mix :** piste stéréo 48 kHz, AAC 320 kb/s par défaut ou FLAC. Silences, solos, volumes de piste et zones sont ceux du projet au lancement de l’export. Le volume d’écoute du lecteur n’influence pas le fichier.
- **Original :** option pour conserver aussi la piste audio originale sélectionnée lors de l’import, sans modification. Elle reste une piste séparée, non choisie par défaut dans le MKV.
- **Sous-titres :** options indépendantes pour les SRT original et traduit actuels du projet. Ils restent sélectionnables dans le lecteur ; ils ne sont pas incrustés dans l’image.
- **Métadonnées :** langues source/cible, titres des pistes, métadonnées et chapitres du média. Le mix est la piste audio par défaut.

L’export respecte un instantané sauvegardé du projet. Vous pouvez continuer à éditer ; ces modifications serviront à l’export suivant. **Traitements** affiche l’assemblage puis le mixage, avec progression, logs et annulation. Un échec ou une annulation conserve un éventuel ancien fichier de destination. Réessayer après modification du projet exige de relancer depuis Exporter.

L’assemblage des prises utilise des tampons bornés ; les milliers de répliques ne deviennent pas des milliers d’entrées FFmpeg. Il utilise un fichier temporaire mono float32 d’environ **346 Mo par heure de vidéo**, plus le MKV en cours, sur le disque de destination. Au-delà de 128 voix simultanées, l’export est refusé. Les sommets dépassant 0 dB sont écrêtés ; baissez les niveaux pour éviter la saturation. Aucun équilibrage automatique de loudness n’est appliqué.

Chaque projet garde une paire de langues source/cible. Ce MKV peut contenir le mix cible et l’original ; l’édition simultanée de plusieurs doublages cibles dans un même projet n’est pas ajoutée par cette version.

## Correction CosyVoice3 sur un stockage personnalisé

L’erreur `\\?\F:\...\model/cosyvoice3.yaml not found!` pouvait survenir alors que tous les fichiers étaient installés et vérifiés. Le constructeur officiel concaténait un `/` au chemin Windows étendu `\\?\...` ; Windows n’effectue pas la normalisation habituelle des séparateurs avec ce préfixe. Les chemins YAML, ONNX, poids et autres fichiers du constructeur utilisent désormais les jointures natives.

Installez 0.7.0, redémarrez l’application et relancez la génération. **Les poids n’ont pas changé et n’ont pas besoin d’être retéléchargés** pour cette erreur. Une véritable absence de fichier ou une empreinte incorrecte déclenche toujours les vérifications habituelles ; utilisez alors **Modèles → Vérifier / réparer CosyVoice3**.

Le correctif a produit un WAV Windows réel de 1,52 s à 24 kHz avec le même préfixe étendu. Un test du constructeur couvre aussi les espaces, accents et chemins de plus de 260 caractères. Le matériel de développement n’est pas une RTX 5060 Ti : cet essai valide les chemins et l’intégration, sans constituer une mesure de performance de votre GPU.

![Écoute synchronisée et piste Doublage](screenshots/phase7-mix.png)

![Options de mix et export MKV](screenshots/phase7-export.png)

Captures de l’interface React réelle dans les tests Chrome, avec prises synthétiques et résultats natifs simulés. Les tests Rust produisent et inspectent séparément de vrais MKV avec FFmpeg.

Références : [chemins Windows étendus](https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation), [filtres audio FFmpeg](https://ffmpeg.org/ffmpeg-filters.html), [validation et limites](../VALIDATION.md).
