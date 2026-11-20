import { FR_SELL } from './fr.js';
import { FR_BUY } from './fr_buy.js';
import { FR_MONEY } from './fr_money.js';
import { FR_CRM } from './fr_crm.js';
// Screens are written in English and shown in French by default. t('Text {n}', {n: 3}).
// Customer documents (invoices, proformas, statements) are always French.
let LANG = 'fr';
try { LANG = localStorage.getItem('sl-lang') || 'fr'; } catch { /* private mode */ }
export const lang = () => LANG;
// Runs fn with screens in another language without saving it (customer documents are French).
export function withLang(l, fn) {
  const keep = LANG;
  LANG = l;
  try { return fn(); } finally { LANG = keep; }
}
export function setLang(l) {
  LANG = l === 'en' ? 'en' : 'fr';
  try { localStorage.setItem('sl-lang', LANG); } catch { /* private mode */ }
  document.documentElement.lang = LANG;
}

// plural(3, 'box', 'boxes') → 'cartons'
// French uses the singular for 0 and 1 (0 paire), English only for 1.
export const plural = (n, one, many) => { const a = Math.abs(Number(n)); return t((LANG === 'fr' ? a < 2 : a === 1) ? one : many); };

export function t(key, vars) {
  let s = LANG === 'fr' ? (FR[key] ?? key) : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return s;
}

const FR = {
  // shell
  'Shoes by the box': 'Chaussures au carton', 'Daily': 'Au quotidien', 'Goods': 'Marchandise', 'Money': 'Argent', 'More': 'Plus',
  'Home': 'Accueil', 'Sales': 'Ventes', 'Orders': 'Commandes', 'Invoices': 'Factures', 'Customers': 'Clients',
  'Stock': 'Stock', 'Products': 'Produits', 'Inventory': 'Inventaire', 'Boxes': 'Cartons', 'Purchasing': 'Achats',
  'Settings': 'Réglages', 'Import data': 'Importer les données', 'Sign out': 'Se déconnecter', 'Language': 'Langue',
  'Menu': 'Menu', 'Close': 'Fermer', 'Back': 'Retour', 'Search': 'Rechercher', 'All': 'Tout',
  'Online · all changes saved': 'En ligne · tout est enregistré', 'Uploading changes…': 'Envoi des changements…',
  'Offline · changes saved on this device': 'Hors ligne · changements gardés sur cet appareil',
  'Offline · working from this device': 'Hors ligne · données de cet appareil', 'Connecting…': 'Connexion…',
  'Loading your data…': 'Chargement de vos données…', 'Coming in the next stage': 'Arrive à la prochaine étape',
  'This part of the app is being rebuilt. Until then, use your current app for it.': 'Cette partie de l’application est en reconstruction. En attendant, utilisez votre application actuelle.',
  // sign-in
  'Sign in': 'Se connecter', 'Continue with Google': 'Continuer avec Google', 'or use email': 'ou par e-mail',
  'Email': 'E-mail', 'Password': 'Mot de passe', 'Please wait…': 'Patientez…', 'Try again': 'Réessayer',
  'Connect the database': 'Connecter la base de données',
  'This copy of the app doesn’t have its Firebase settings yet.': 'Cette copie de l’application n’a pas encore ses réglages Firebase.',
  'Not allowed': 'Accès refusé',
  'This account can’t open the data. Check that the security rules are published with your email, then try again.': 'Ce compte ne peut pas ouvrir les données. Vérifiez que les règles de sécurité sont publiées avec votre e-mail, puis réessayez.',
  'Sign in with another account': 'Utiliser un autre compte',
  'Wrong email or password.': 'E-mail ou mot de passe incorrect.',
  'No internet connection. Signing in needs the internet once; after that the app works offline.': 'Pas de connexion. La première connexion a besoin d’internet ; ensuite l’application marche hors ligne.',
  'Couldn’t sign in. Try again.': 'Connexion impossible. Réessayez.',
  'This web address isn’t allowed yet. In Firebase, open Authentication → Settings → Authorized domains and add it.': 'Cette adresse n’est pas encore autorisée. Dans Firebase, ouvrez Authentication → Settings → Authorized domains et ajoutez-la.',
  // home
  'Good morning': 'Bonjour', 'Stock value': 'Valeur du stock', 'Customers owe': 'Les clients doivent',
  'Cash on hand': 'Trésorerie', 'Boxes in stock': 'Cartons en stock', 'at landed cost': 'au coût de revient',
  'on {n} invoices': 'sur {n} factures', 'on 1 invoice': 'sur 1 facture', 'across your accounts': 'sur vos comptes', 'sealed boxes': 'cartons fermés',
  'Recent orders': 'Commandes récentes', 'Low stock': 'Stock bas', 'Delivered, not invoiced': 'Livré, pas facturé',
  'Nothing is low.': 'Rien n’est bas.', 'No orders yet.': 'Aucune commande.', 'See all': 'Tout voir',
  'Your data isn’t here yet': 'Vos données ne sont pas encore là',
  'Import the backup from your current app to see your stock, customers and sales here.': 'Importez la sauvegarde de votre application actuelle pour voir ici votre stock, vos clients et vos ventes.',
  // stock
  'box': 'carton', 'invoice': 'facture', 'invoices': 'factures', 'Styles': 'Modèles', 'pairs': 'paires', 'pair': 'paire', 'sizes': 'pointures', 'Size': 'Pointure', 'Color': 'Couleur',
  'On hand': 'En stock', 'Cost': 'Coût', 'Price': 'Prix', 'Reorder at': 'Seuil', 'Brand': 'Marque', 'Category': 'Catégorie',
  'No products yet.': 'Aucun produit.', 'Search a style, brand or code': 'Chercher un modèle, une marque, un code',
  'low': 'bas', 'Mixes in stock': 'Assortiments en stock', 'Mix': 'Assortiment', 'In stock': 'En stock', 'Sold': 'Vendus',
  'Pairs per box': 'Paires par carton', 'Received': 'Reçu', 'Supplier': 'Fournisseur', 'No boxes yet.': 'Aucun carton.',
  'Box': 'Carton', 'Status': 'Statut', 'Location': 'Emplacement', 'sealed': 'fermé', 'open': 'ouvert', 'sold': 'vendu', 'emptied': 'vidé',
  'Contents of one box': 'Contenu d’un carton', 'Boxes of this mix': 'Cartons de cet assortiment', 'Pairs left': 'Paires restantes',
  'Sizes and stock': 'Pointures et stock', 'Total': 'Total', 'Value': 'Valeur', 'Code': 'Code',
  // customers
  'Owes': 'Doit', 'Bought': 'Acheté', 'Phone': 'Téléphone', 'Address': 'Adresse', 'Credit limit': 'Plafond de crédit',
  'No customers yet.': 'Aucun client.', 'Search a name or phone': 'Chercher un nom ou un téléphone', 'days': 'jours',
  'oldest unpaid: {n} days': 'plus ancienne impayée : {n} jours', 'Account history': 'Historique du compte',
  'Invoice': 'Facture', 'Payment': 'Paiement', 'Return': 'Retour', 'Charge': 'Débit', 'Paid': 'Payé', 'Balance': 'Solde',
  'Last payment': 'Dernier paiement', 'Lifetime sales': 'Ventes totales', 'What they buy': 'Ce qu’il achète',
  'Avg per box': 'Moyenne par carton', 'In credit': 'Avoir', 'boxes': 'cartons', 'loose pairs': 'paires au détail',
  'on {inv}': 'sur {inv}', '{n} returned': '{n} retournées', 'Discount': 'Remise',
  // orders & invoices
  'Order': 'Commande', 'Customer': 'Client', 'Date': 'Date', 'Currency': 'Devise', 'Notes': 'Notes',
  'draft': 'brouillon', 'fulfilled': 'livrée', 'cancelled': 'annulée', 'confirmed': 'confirmée',
  'Delivered': 'Livrée', 'Open': 'Ouverte', 'Cancelled': 'Annulée', 'No invoices yet.': 'Aucune facture.',
  'paid': 'payée', 'partial': 'partielle', 'unpaid': 'impayée', 'void': 'annulée', 'unpriced': 'sans prix',
  'Due': 'Dû', 'Whole boxes': 'Cartons entiers', 'Loose pairs': 'Paires au détail', 'boxes ×': 'cartons ×',
  'per box': 'le carton', 'per pair': 'la paire', 'Walk-in customer': 'Client de passage', 'Search an order or customer': 'Chercher une commande ou un client',
  'Payments': 'Paiements', 'No payments yet.': 'Aucun paiement.', 'Order total': 'Total de la commande',
  // import
  'Import your data': 'Importer vos données',
  'Bring everything from your current Stock & Ledger app: stock, boxes, customers, orders, invoices, payments, purchases, accounts and photos.': 'Récupérez tout depuis votre application Stock & Ledger actuelle : stock, cartons, clients, commandes, factures, paiements, achats, comptes et photos.',
  'Choose the backup file': 'Choisir le fichier de sauvegarde',
  'In your current app, open Backup and click “Download a backup now”. Then choose that .zip file here.': 'Dans votre application actuelle, ouvrez Sauvegarde et cliquez « Télécharger une sauvegarde maintenant ». Puis choisissez ce fichier .zip ici.',
  'Reading the backup…': 'Lecture de la sauvegarde…', 'Checking…': 'Vérification…',
  'What this backup holds': 'Ce que contient cette sauvegarde', 'Table': 'Table', 'Rows': 'Lignes', 'Photos': 'Photos', 'Documents': 'Documents',
  'Replace all data in this app with this backup': 'Remplacer toutes les données de cette application par cette sauvegarde',
  'Import now': 'Importer maintenant', 'Uploading… {done} of {total}': 'Envoi… {done} sur {total}',
  'Imported and checked': 'Importé et vérifié', 'Import finished, but the check found differences': 'Import terminé, mais la vérification a trouvé des différences',
  'Every table matches the backup row for row.': 'Chaque table correspond à la sauvegarde, ligne par ligne.',
  'That file isn’t a Stock & Ledger backup.': 'Ce fichier n’est pas une sauvegarde Stock & Ledger.',
  'Match': 'Identique', 'Different': 'Différent', 'In backup': 'Dans la sauvegarde', 'In this app': 'Dans cette application',
  'This app already has data. Importing replaces all of it with the backup.': 'Cette application contient déjà des données. L’import les remplace toutes par la sauvegarde.',
  'Too large to keep (over 700 KB), so it stays in your old app:': 'Trop lourd (plus de 700 Ko), il reste dans votre ancienne application :',
  'Firebase writes needed': 'Écritures Firebase nécessaires', 'Free limit per day': 'Limite gratuite par jour',
  'Key figures': 'Chiffres clés', 'Old app': 'Ancienne appli', 'New app': 'Nouvelle appli',
  // switching over: what an import changes, and a copy of this app first
  'What changes in this app': 'Ce qui change dans cette application', 'Records added': 'Enregistrements ajoutés',
  'Records changed': 'Enregistrements modifiés', 'Records removed': 'Enregistrements supprimés',
  'Newest entry in this backup': 'Saisie la plus récente dans la sauvegarde', 'Newest imported entry in this app': 'Saisie importée la plus récente dans l’application',
  'This backup is older than the data already in this app. Check that you chose the newest backup from your old app.': 'Cette sauvegarde est plus ancienne que les données déjà dans l’application. Vérifiez que vous avez choisi la sauvegarde la plus récente de votre ancienne application.',
  '{n} record(s) were entered in this app and are not in this backup:': '{n} enregistrement(s) ont été saisis dans cette application et ne sont pas dans cette sauvegarde :',
  'Importing removes them. Download a copy of this app first, so you can get them back if you need to.': 'L’import les supprime. Téléchargez d’abord une copie de l’application, pour pouvoir les récupérer si besoin.',
  'Download a copy of this app first': 'Télécharger d’abord une copie de l’application', 'Download the copy above first.': 'Téléchargez d’abord la copie ci-dessus.',
  'Preparing the copy… {d} of {n} files': 'Préparation de la copie… {d} fichiers sur {n}', 'Copy saved: {f}': 'Copie enregistrée : {f}',
  'The copy couldn’t be made: {e}': 'La copie n’a pas pu être faite : {e}', 'From now on': 'À partir de maintenant',
  'Enter new sales, payments and purchases only in this app. Keep your old app as it is for a few weeks in case you need to look something up, but don’t enter anything there any more, or the two will no longer agree.': 'Saisissez les nouvelles ventes, paiements et achats uniquement dans cette application. Gardez l’ancienne application telle quelle quelques semaines pour consulter si besoin, mais n’y saisissez plus rien, sinon les deux ne correspondront plus.',
  'Go to the home page': 'Aller à l’accueil', 'Import another backup': 'Importer une autre sauvegarde',
  'orders': 'commandes', 'order lines': 'lignes de commande', 'box lines': 'lignes de cartons', 'payments': 'paiements', 'customers': 'clients',
  'returns': 'retours', 'returned items': 'articles retournés', 'box contents': 'contenus de cartons', 'purchase order lines': 'lignes de bon de commande',
  'cost lines': 'lignes de frais', 'supplier payments': 'paiements fournisseurs', 'suppliers': 'fournisseurs', 'styles': 'modèles',
  'colors and sizes': 'couleurs et pointures', 'CRM contacts': 'contacts CRM', 'CRM notes': 'notes CRM', 'stock movements': 'mouvements de stock'
};
Object.assign(FR, FR_SELL, FR_BUY, FR_MONEY, FR_CRM);
