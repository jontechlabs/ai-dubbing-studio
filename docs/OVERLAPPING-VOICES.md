# Voix simultanées et sous-doublages

Dans **Doublage → Isoler plusieurs voix**, choisissez la piste contenant les voix, le séparateur et le périphérique. L’installation affiche l’espace nécessaire et disponible avant de télécharger les dépendances. Les modèles restent dans le dossier configuré dans les paramètres.

Les modèles intégrés sont :

| Modèle | Voix en sortie | Résolution du modèle | Source |
|---|---:|---:|---|
| MossFormer2_SS_16K, cœur de ClearerVoice Studio | 2 | 16 kHz | [Carte officielle](https://huggingface.co/alibabasglab/MossFormer2_SS_16K) |
| SepFormer Libri2Mix | 2 | 8 kHz | [Carte officielle](https://huggingface.co/speechbrain/sepformer-libri2mix) |
| SepFormer Libri3Mix | 3 | 8 kHz | [Carte officielle](https://huggingface.co/speechbrain/sepformer-libri3mix) |

ClearerVoice Studio est le projet qui fournit MossFormer2 ; il ne constitue pas un quatrième séparateur. Les modèles ont un nombre fixe de sorties : choisissez celui qui correspond au passage. Les sorties à 48 kHz conservent exactement la durée de la réplique ; le rééchantillonnage ne reconstitue pas les fréquences absentes d’un modèle à 8 ou 16 kHz.

La séparation est locale, sur CPU ou sur le GPU CUDA explicitement choisi. Le profil utilise des fenêtres de deux secondes avec recouvrement, réordonne les sorties par corrélation dans le recouvrement et applique un gain commun pour conserver leur balance relative. Il ne bascule pas silencieusement du GPU au CPU. La mémoire du modèle est libérée à la fin du processus ou lors de son annulation. Les séquences sont limitées à 60 secondes. Les essais de qualification sur Windows CPU utilisent les vrais poids ; aucune mesure de vitesse ou de VRAM sur RTX 5060 Ti n’est annoncée.

## Écouter et affecter les sorties

L’analyse et sa progression restent dans le panneau Doublage. Écoutez chaque voix avant de l’utiliser. Les sorties « Voix 1 », « Voix 2 », « Voix 3 » sont des propositions ; elles ne reconnaissent pas automatiquement un personnage. Leur ordre peut être ambigu après un silence ou un changement de plan. Une séparation imparfaite peut conserver du bruit, des fuites entre personnes ou des artefacts, particulièrement sur les animes et les scènes éloignées des données d’entraînement.

Pour affecter les voix à des pistes, choisissez une destination pour chacune, puis **Remplacer la portion** ou **Ajouter aux sons existants**. Les horaires restent ceux du dialogue. Si plusieurs sorties vont vers la même piste en remplacement, la première remplace la portion et les suivantes s’y ajoutent : elles ne s’effacent pas mutuellement. L’option de retrait de la portion source ajoute une couche réversible de silence. Ctrl+Z annule l’affectation complète. La vidéo et les fichiers source restent intacts.

## Doubler les personnages indépendamment

Renseignez un nom, un personnage et les textes propres à chaque voix, puis cliquez sur **Créer les sous-doublages indépendants**. Il est possible de laisser les textes vides et d’utiliser ensuite l’aide à la transcription et à la traduction de chaque sous-doublage. La transcription d’une voix isolée corrige son texte interne ; elle n’ajoute pas de sous-titre au SRT d’origine.

Les boutons du groupe permettent d’ouvrir chaque voix dans le même panneau. La génération utilise son audio isolé comme référence courante, et les références françaises de personnage ou de fichier restent disponibles. Les exigences habituelles du moteur s’appliquent : durée minimale de référence et transcription exacte pour les modes qui la demandent. Le texte japonais ou français du dialogue principal n’est pas dupliqué automatiquement sur chaque personne.

Chaque sous-doublage possède ses textes, personnage, réglages, essais, validation, montage, volume, décalage et durée. Les essais précédents de la réplique principale sont conservés. Les voix actives du même groupe sont mixées simultanément à la lecture et dans l’export MKV ; la réplique principale n’est pas superposée au groupe. La piste Doublage présente jusqu’à trois rangées pour les manipuler séparément. Les chevauchements de répliques sans lien continuent d’être signalés.

Le sélecteur **Doublage actif** permet de revenir à l’essai principal ou à un groupe conservé. Exclure toutes les voix d’un groupe rend celui-ci silencieux ; cela ne réactive pas accidentellement l’ancienne voix. Sélectionner explicitement un ancien essai principal restaure ce doublage. Le doublage par lot peut traiter les voix actives ; sélectionner leur réplique principale développe sa sélection vers ces voix. Les SRT source et traduit restent inchangés.

Les groupes utilisent le **format de projet 25**. Cette version ouvre les anciens projets ; une version antérieure ne peut pas ouvrir un projet enregistré avec des groupes. La sauvegarde, l’annulation et la réouverture conservent les groupes et toutes leurs prises.

La validation de la réplique principale résume celle des sous-doublages actifs. Valider une sélection contenant cette réplique applique la validation aux voix du groupe ; une correction de leur texte ou de leur essai retire leur validation. Les validations et essais de la version principale précédente sont conservés pour un retour ultérieur.

## Pilotage MCP

Les sept commandes supplémentaires sont `studio_speaker_separation_status`, `studio_install_speaker_separation_model`, `studio_separate_dialogue_speakers`, `studio_speaker_separation_result`, `studio_speaker_separation_path`, `studio_apply_speaker_separation_result` et `studio_create_speaker_dubbings`. Les mutations utilisent le contexte courant. L’installation et la séparation renvoient un identifiant de tâche à suivre avec `studio_list_jobs` et à annuler avec `studio_cancel_job`. L’édition des textes, l’affectation des personnages, les essais, le montage et l’export utilisent les commandes existantes.

Cette version comprend aussi la [préécoute des sélections et les références avant volumes/muets](REFERENCE-AUDIO-LEVELS.md).
