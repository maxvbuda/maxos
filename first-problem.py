"""
Problem 1: The Password Analyzer
This problem transitions from checking a single input to checking a string character by character.
1. Ask the user to enter a new password.
2. Create two variables to keep score: one to count the number of digits (numbers), and one to count the number of uppercase letters. Set both to 0 to start.
3. Use a for loop to look at every single character in the password.
4. Inside the loop, check if the character is a letter. If it is a letter, use an embedded conditional to check if it is uppercase.
5. Also inside the loop, check if the character is a digit.
6. After the loop finishes, print out how many uppercase letters and how many digits the password has. If it has at least 1 of both, print "Strong password!" Otherwise, print "Weak password!"
"""

password = input("Enter a new password: ")
digits = 0
uppercase = 0
for character in password:
    
    if character.isalpha():
        if character.isupper():
            uppercase += 1
    if character.isdigit():
        digits += 1
if digits > 0 and uppercase > 0:
    print(f"Strong password! Your password has {digits} digits and {uppercase} uppercase letters.")
else:
    print(f"Weak password! Your password has {digits} digits and {uppercase} uppercase letters.")