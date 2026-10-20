# v0.20.0 — Transfert d’intonation expérimental

Ce mode transforme un **essai existant**, sans relancer CosyVoice et sans remplacer ses fichiers. Pour combiner une prononciation française et le jeu d’une réplique japonaise, générez d’abord une voix française avec votre référence française, puis utilisez l’audio japonais comme guide d’intonation.

## Utilisation

1. Ouvrez **Doubler / Régénérer** sur la réplique, puis **Transfert d’intonation · Expérimental** dans les essais.
2. Sélectionnez l’essai français dont la prononciation vous convient, par exemple celui créé avec **Jeune blond FINAL**.
3. Choisissez **Audio original de cette réplique** comme guide. La piste Voix est utilisée si disponible ; vous pouvez choisir une autre piste. Un fichier de référence déjà importé dans le projet ou un personnage peut aussi servir de guide.
4. Commencez à **50 %** avec **Mélodie**, **Rythme** et **Énergie**, puis créez le nouvel essai. Comparez-le à l’original et réduisez l’intensité si le résultat semble artificiel.
5. Vous pouvez désactiver le rythme pour conserver la durée de la base, ou ne transférer que l’énergie. Les réglages précédents et la base d’origine sont repris à la réouverture d’un essai dérivé, lorsque cette base existe encore.

![Transfert d’intonation](screenshots/prosody-transfer-fr.png)

*Interface React réelle avec données synthétiques et commandes natives simulées. Les tests natifs utilisent séparément le véritable moteur Praat.*

Le nouvel essai est sélectionné et écoutable avec les commandes habituelles. Tous les essais précédents et la vidéo principale sont conservés. À 0 %, le son de l’essai de base est recopié sans transformation. Une annulation, une erreur ou une révision du projet devenue obsolète ne valide aucun nouvel essai.

## Fonctionnement et limites

Il s’agit d’un **transfert acoustique approximatif**, et non d’un modèle neuronal capable de séparer parfaitement accent et émotion. Le son français reste la source : l’audio japonais n’est jamais mélangé au résultat. Le traitement reprend les contours de hauteur et d’énergie du guide, avec une correspondance temporelle monotone fondée sur l’énergie. Il ne traduit pas les phonèmes et ne sait pas faire correspondre exactement des syllabes de langues différentes.

- Praat 6.4.67 effectue l’analyse et la resynthèse PSOLA sur **CPU** ; aucun modèle à télécharger et aucune VRAM supplémentaire ne sont nécessaires.
- La hauteur est adaptée au registre de la voix française, avec un changement limité à quatre demi-tons. Le rythme local reste entre 80 et 125 % de la durée d’origine, avant pondération par l’intensité. L’énergie est lissée et bornée pour préserver les consonnes ; le niveau de crête est limité sans couper la fin du signal.
- Base et guide doivent durer **150 ms à 30 secondes**. La base tient compte de son montage audio actuel. Un guide silencieux ou sans hauteur exploitable peut être refusé ; un fichier propre sans musique donne généralement une analyse plus utile.
- La durée peut changer si le rythme est activé. Le calage manuel et les réglages de durée habituels restent disponibles. Un essai qui dépasse le créneau est signalé pour révision.
- Une langue mieux prononcée dépend d’abord de l’essai de base. Le transfert ne corrige pas une prononciation déjà incorrecte et ne garantit pas une reproduction exacte du jeu japonais. La qualité doit être évaluée à l’écoute ; les diagnostics automatiques vérifient le signal et la conservation des fichiers, pas la fidélité émotionnelle.

Seuls les projets contenant un essai dérivé passent au **format 14**. Ouvrez-les avec v0.20.0 ou ultérieure. Les prises dérivées restent autonomes si vous supprimez ensuite leur essai de base.

## MCP

`studio_prosody_status` indique la disponibilité du moteur. `studio_transfer_voice_prosody` demande le contexte courant du projet et les options suivantes :

```json
{
  "generationId": "id-de-l-essai-francais",
  "referenceMode": "dialogue",
  "referenceId": null,
  "characterId": null,
  "referenceTrackId": "auto",
  "strength": 0.5,
  "pitch": true,
  "rhythm": true,
  "energy": true
}
```

Pour un fichier importé, utilisez `referenceMode: "reference"` et son `referenceId`, avec `characterId` si la référence appartient à un personnage. Le résultat est un identifiant de tâche à suivre avec `studio_list_jobs` ; utilisez `studio_cancel_job` pour annuler. Après réussite, relisez le projet et comparez les identifiants des prises.

## English

Open the dubbing panel, expand **Intonation transfer · Experimental**, choose an existing French take, then select the original dialogue audio or an imported reference as the prosody guide. Start at 50%, compare the new take, and reduce strength or disable rhythm if needed. All existing takes and source media remain intact. This is bounded CPU acoustic contour transfer with Praat PSOLA, not a neural two-reference voice-cloning model. Cross-language syllable alignment and acting fidelity are approximate. Source and guide are limited to 150 ms–30 seconds. Only projects with derived takes require format 14. Both new operations are available through MCP.

Praat is distributed as a separate GPL-3.0-or-later executable. [Pinned source](https://github.com/praat/praat/tree/v6.4.67), [Manipulation](https://www.fon.hum.uva.nl/praat/manual/Manipulation.html), [overlap-add resynthesis](https://www.fon.hum.uva.nl/praat/manual/Manipulation__Get_resynthesis__overlap-add_.html). See [third-party notices](../THIRD-PARTY-NOTICES.txt) and the bundled license.
